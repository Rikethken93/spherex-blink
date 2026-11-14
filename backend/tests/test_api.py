"""API endpoint tests against a mocked IRSA -- no real network calls."""
from __future__ import annotations

import numpy as np
import pytest
from astropy.wcs import WCS
from fastapi.testclient import TestClient

from app import service
from app.irsa_client import Exposure, ExposureMeta
from app.main import app

client = TestClient(app)

RA0, DEC0 = 180.0, 10.0


def _fake_exposure(mjd: float, detector: int = 3, value: float = 50.0) -> Exposure:
    npix = 16
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [RA0, DEC0]
    wcs.wcs.crpix = [npix / 2 + 0.5, npix / 2 + 0.5]
    wcs.wcs.cdelt = [-6.2 / 3600.0, 6.2 / 3600.0]
    image = np.full((npix, npix), 5.0, dtype=np.float32)
    image[npix // 2, npix // 2] = value
    flags = np.zeros((npix, npix), dtype=np.int32)
    variance = np.ones((npix, npix), dtype=np.float32)
    meta = ExposureMeta(
        access_url="synthetic://test",
        obs_id=f"fake-{mjd}-{detector}",
        detector=detector,
        em_min_um=1.63,
        em_max_um=2.41,
        t_min_mjd=mjd,
        t_max_mjd=mjd,
        obs_collection="synthetic_test_data",
    )
    return Exposure(meta=meta, image=image, flags=flags, variance=variance, wcs=wcs, spectral_wcs=None, mjd=mjd)


@pytest.fixture
def mock_coverage(monkeypatch, tmp_path):
    monkeypatch.setattr(service.config, "CACHE_DIR", str(tmp_path))

    metas = [
        ExposureMeta(
            access_url="synthetic://test",
            obs_id=f"fake-meta-{i}",
            detector=3,
            em_min_um=1.63,
            em_max_um=2.41,
            t_min_mjd=60000.0 + i * 200,
            t_max_mjd=60000.0 + i * 200,
            obs_collection="synthetic_test_data",
        )
        for i in range(3)
    ]
    exposures = [_fake_exposure(m.t_min_mjd) for m in metas]

    monkeypatch.setattr(service, "query_exposure_metadata", lambda *a, **k: metas)
    monkeypatch.setattr(service, "fetch_exposures", lambda *a, **k: exposures)
    return metas, exposures


@pytest.fixture
def mock_coverage_multiband(monkeypatch, tmp_path):
    monkeypatch.setattr(service.config, "CACHE_DIR", str(tmp_path))

    # Three detectors, each with a distinctly bright center pixel, all in
    # the same epoch -- so an RGB composite should show a different
    # brightness per channel, not the same blended image three times.
    specs = [(1, 20.0), (3, 120.0), (6, 220.0)]
    metas = [
        ExposureMeta(
            access_url="synthetic://test",
            obs_id=f"fake-meta-d{detector}",
            detector=detector,
            em_min_um=1.0,
            em_max_um=2.0,
            t_min_mjd=60000.0,
            t_max_mjd=60000.0,
            obs_collection="synthetic_test_data",
        )
        for detector, _ in specs
    ]
    exposures = [_fake_exposure(60000.0, detector=d, value=v) for d, v in specs]

    monkeypatch.setattr(service, "query_exposure_metadata", lambda *a, **k: metas)
    monkeypatch.setattr(service, "fetch_exposures", lambda *a, **k: exposures)
    return metas, exposures


@pytest.fixture
def mock_no_coverage(monkeypatch, tmp_path):
    monkeypatch.setattr(service.config, "CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(service, "query_exposure_metadata", lambda *a, **k: [])


def test_health():
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_targets_list_includes_required_five():
    resp = client.get("/api/targets")
    assert resp.status_code == 200
    keys = {t["key"] for t in resp.json()}
    required = {t["key"] for t in resp.json() if t["required"]}
    assert len(required) == 5
    assert keys.issuperset(required)


def test_frames_rejects_fov_out_of_range():
    resp = client.get("/api/frames", params={"ra": "180.0", "dec": "10.0", "fov": 50})
    assert resp.status_code == 422  # FastAPI query validation


def test_frames_rejects_bad_mode(mock_coverage):
    resp = client.get("/api/frames", params={"ra": "180.0", "dec": "10.0", "fov": 3, "mode": "not-a-mode"})
    assert resp.status_code == 400


def test_frames_no_coverage_returns_404(mock_no_coverage):
    resp = client.get("/api/frames", params={"ra": "180.0", "dec": "10.0", "fov": 3})
    assert resp.status_code == 404
    assert "coverage" in resp.json()["detail"].lower()


def test_frames_blink_mode_returns_one_frame_per_epoch(mock_coverage):
    resp = client.get("/api/frames", params={"ra": "180.0", "dec": "10.0", "fov": 3, "mode": "blink"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["mode"] == "blink"
    assert len(body["frames"]) == 3  # 3 synthetic epochs, 200 days apart
    assert len(body["epochs"]) == 3
    assert all(url.startswith("/cache/frames/") for url in body["frame_urls"])
    # Regression check: cache_key_dir is already relative to CACHE_DIR
    # ("frames/<hash>"), so the URL must not double up to
    # "/cache/frames/frames/<hash>/...".
    assert all("frames/frames" not in url for url in body["frame_urls"])
    # The URL must actually resolve through the static mount, not just look right.
    frame_resp = client.get(body["frame_urls"][0])
    assert frame_resp.status_code == 200
    assert frame_resp.headers["content-type"] == "image/png"


def test_frames_sum_mode_returns_single_frame(mock_coverage):
    resp = client.get("/api/frames", params={"ra": "180.0", "dec": "10.0", "fov": 3, "mode": "sum"})
    assert resp.status_code == 200
    assert len(resp.json()["frames"]) == 1


def test_frames_accepts_sexagesimal_coordinates(mock_coverage):
    resp = client.get(
        "/api/frames",
        params={"ra": "12h00m00s", "dec": "+10d00m00s", "fov": 3, "mode": "sum"},
    )
    assert resp.status_code == 200
    assert resp.json()["ra_deg"] == pytest.approx(180.0, abs=1e-6)


def test_frames_cache_hit_on_second_call(mock_coverage):
    first = client.get("/api/frames", params={"ra": "180.0", "dec": "10.0", "fov": 3, "mode": "sum"})
    assert first.json()["cache_hit"] is False
    second = client.get("/api/frames", params={"ra": "180.0", "dec": "10.0", "fov": 3, "mode": "sum"})
    assert second.json()["cache_hit"] is True


def test_spectrum_endpoint(mock_coverage):
    resp = client.get("/api/spectrum", params={"ra": "180.0", "dec": "10.0"})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["points"]) == 3  # one per synthetic exposure
    for point in body["points"]:
        assert point["wavelength_um"] > 0


def test_lightcurve_endpoint(mock_coverage):
    resp = client.get("/api/lightcurve", params={"ra": "180.0", "dec": "10.0"})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["points"]) == 3


def test_spectrum_is_cached_and_does_not_requery_on_second_call(mock_coverage, monkeypatch):
    calls = {"n": 0}
    real_query = service.query_exposure_metadata

    def counting_query(*a, **k):
        calls["n"] += 1
        return real_query(*a, **k)

    monkeypatch.setattr(service, "query_exposure_metadata", counting_query)

    first = client.get("/api/spectrum", params={"ra": "180.0", "dec": "10.0"})
    second = client.get("/api/spectrum", params={"ra": "180.0", "dec": "10.0"})
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json() == second.json()
    assert calls["n"] == 1  # the second call must be a cache hit, not a re-query


def test_lightcurve_is_cached_and_does_not_requery_on_second_call(mock_coverage, monkeypatch):
    calls = {"n": 0}
    real_query = service.query_exposure_metadata

    def counting_query(*a, **k):
        calls["n"] += 1
        return real_query(*a, **k)

    monkeypatch.setattr(service, "query_exposure_metadata", counting_query)

    first = client.get("/api/lightcurve", params={"ra": "180.0", "dec": "10.0"})
    second = client.get("/api/lightcurve", params={"ra": "180.0", "dec": "10.0"})
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json() == second.json()
    assert calls["n"] == 1


def test_lightcurve_sparse_epoch_serializes_nan_as_null(monkeypatch, tmp_path):
    """Regression test: a sparse epoch with no valid pixels in the
    aperture makes aperture_photometry return NaN, and Python's
    json.dumps writes a literal `NaN` token by default -- not valid JSON,
    and something a browser's JSON.parse rejects outright."""
    monkeypatch.setattr(service.config, "CACHE_DIR", str(tmp_path))

    meta = ExposureMeta(
        access_url="synthetic://test", obs_id="fake-sparse", detector=3,
        em_min_um=1.63, em_max_um=2.41, t_min_mjd=60000.0, t_max_mjd=60000.0,
        obs_collection="synthetic_test_data",
    )
    exposure = _fake_exposure(60000.0)
    exposure.flags[:] = 1  # every pixel flagged -> every pixel masked to NaN

    monkeypatch.setattr(service, "query_exposure_metadata", lambda *a, **k: [meta])
    monkeypatch.setattr(service, "fetch_exposures", lambda *a, **k: [exposure])

    resp = client.get("/api/lightcurve", params={"ra": "180.0", "dec": "10.0"})
    assert resp.status_code == 200
    assert "NaN" not in resp.text  # would be invalid JSON if present
    point = resp.json()["points"][0]
    assert point["flux"] is None
    assert point["error"] is None


def test_rgb_mode_uses_a_distinct_stack_per_band(mock_coverage_multiband):
    """Regression test: stack_epoch blends every detector in an epoch into
    one combined image, so naively reusing stacked-epoch images per
    "band" produced the identical frame in all three RGB channels. RGB
    mode must instead build one single-band deep stack per channel."""
    from PIL import Image

    resp = client.get("/api/frames", params={"ra": "180.0", "dec": "10.0", "fov": 3, "mode": "rgb"})
    assert resp.status_code == 200
    body = resp.json()
    cache_dir = body["cache_key_dir"]

    png_path = service.config.CACHE_DIR + "/" + cache_dir + "/frame_0.png"
    img = Image.open(png_path)
    arr = np.array(img)
    center = arr[arr.shape[0] // 2, arr.shape[1] // 2]  # [R, G, B]
    r, g, b = int(center[0]), int(center[1]), int(center[2])
    # The three detectors were given very different brightness (20, 120,
    # 220), so the three channels at the bright pixel must differ -- if
    # they were all equal, that's the old bug (same blended image reused
    # for every channel).
    assert len({r, g, b}) == 3, f"expected 3 distinct channel values, got R={r} G={g} B={b}"
