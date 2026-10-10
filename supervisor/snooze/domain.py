"""Shared scheduling values. Provider state is not an editorial/task outcome."""
from dataclasses import dataclass, field


@dataclass(frozen=True)
class TaskSpec:
    id: str
    project_id: str
    scope_keys: tuple[str, ...]
    input_ref: str
    input_hash: str
    requirements: dict
    output_contract: dict
    validator_id: str
    approved: bool = False
    dependencies: tuple[str, ...] = ()


@dataclass(frozen=True)
class AccountSnapshot:
    id: str
    enabled: bool
    capacity: int
    observed_at: float | None
    capabilities: dict
    models: tuple[str, ...]
    quota: dict | None
    health: str


@dataclass(frozen=True)
class AttemptReceipt:
    attempt_id: str
    generation: int
    idempotency_key: str
    session_id: str | None
    state: str


@dataclass(frozen=True)
class CycleReport:
    started_at: float
    finished_at: float
    decisions: list[dict] = field(default_factory=list)
    errors: list[dict] = field(default_factory=list)


@dataclass(frozen=True)
class Eligibility:
    eligible: bool
    reasons: tuple[str, ...]
    rank: tuple = ()


@dataclass(frozen=True)
class ValidationResult:
    state: str
    errors: tuple[str, ...] = ()
    artifact_hash: str | None = None
