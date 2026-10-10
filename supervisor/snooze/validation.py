"""Allowlisted structural output checks; never execute task-supplied code."""
import hashlib
import json
from snooze.domain import ValidationResult


class ValidatorRegistry:
    def validate(self, task, artifact):
        if task.validator_id != 'json-records': return ValidationResult('invalid', ('Unsupported validator',))
        if not isinstance(artifact, dict) or not isinstance(artifact.get('records'), list):
            return ValidationResult('invalid', ('Missing saved records',))
        records = artifact['records']; ids = []; errors = []
        for row in records:
            if not isinstance(row, dict) or 'id' not in row:
                errors.append('Every row needs an id'); continue
            ids.append(str(row['id']))
            if any(field not in row or row[field] is None for field in task.output_contract.get('fields',[])):
                errors.append('Missing required fields')
        expected = sorted(str(id) for id in task.output_contract.get('ids',[]))
        if not expected: errors.append('Output contract needs exact assigned IDs')
        if sorted(ids) != expected or len(ids) != len(set(ids)): errors.append('Missing, duplicate or outside-assignment IDs')
        if errors: return ValidationResult('invalid', tuple(errors))
        digest = hashlib.sha256(json.dumps(artifact, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        return ValidationResult('valid', (), digest)
