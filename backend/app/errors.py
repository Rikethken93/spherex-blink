class NoCoverageError(Exception):
    """Raised when IRSA has no SPHEREx exposures at all for a position/filter
    combination -- a distinct, user-facing case from a transient network
    failure."""


class InvalidRequestError(Exception):
    """Raised for validated-but-rejected input (bad FOV, bad coordinates,
    unknown detector, etc)."""
