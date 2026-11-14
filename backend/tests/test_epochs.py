from app.pipeline.epochs import epoch_summary, group_into_epochs


def test_single_epoch_when_all_close_in_time():
    mjds = [60800.0, 60800.5, 60801.2, 60802.0]
    epochs = group_into_epochs(mjds, lambda m: m, gap_days=60.0)
    assert len(epochs) == 1
    assert epochs[0] == mjds


def test_splits_on_large_gap():
    mjds = [60800.0, 60801.0, 61000.0, 61001.5, 61400.0]
    epochs = group_into_epochs(mjds, lambda m: m, gap_days=60.0)
    assert len(epochs) == 3
    assert epochs[0] == [60800.0, 60801.0]
    assert epochs[1] == [61000.0, 61001.5]
    assert epochs[2] == [61400.0]


def test_unsorted_input_is_sorted_first():
    mjds = [61000.0, 60800.0, 60801.0]
    epochs = group_into_epochs(mjds, lambda m: m, gap_days=60.0)
    assert epochs == [[60800.0, 60801.0], [61000.0]]


def test_empty_input():
    assert group_into_epochs([], lambda m: m) == []


def test_epoch_summary():
    epoch = [60800.0, 60801.0, 60802.0]
    summary = epoch_summary(epoch, lambda m: m)
    assert summary["n_exposures"] == 3
    assert summary["mjd_min"] == 60800.0
    assert summary["mjd_max"] == 60802.0
    assert summary["mjd_mean"] == 60801.0
