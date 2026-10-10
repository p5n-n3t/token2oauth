"""Read legacy queue with bounded tolerance for atomic-write races."""
import json
import time
from pathlib import Path


def read_queue(path: Path) -> list[dict]:
    for attempt in range(3):
        try:
            payload = json.loads(path.read_text())
            return [{**job, 'source_updated_at': payload.get('updated_at')} for job in payload['jobs']]
        except (json.JSONDecodeError, KeyError):
            if attempt == 2:
                raise ValueError('Queue is malformed; original left unchanged') from None
            time.sleep(0.05)
