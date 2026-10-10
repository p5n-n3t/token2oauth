import unittest
from snooze.domain import TaskSpec
from snooze.validation import ValidatorRegistry


class ValidationTests(unittest.TestCase):
    def spec(self): return TaskSpec('a','p',('record:1',),'fixture','hash',{}, {'ids':['1'],'fields':['id','summary']}, 'json-records', True)
    def test_exact_ids_and_fields_not_provider_idle_define_success(self):
        validators = ValidatorRegistry()
        self.assertEqual(validators.validate(self.spec(), {'records':[{'id':'1','summary':'Saved'}]}).state, 'valid')
        self.assertEqual(validators.validate(self.spec(), {'status':'idle'}).state, 'invalid')
        self.assertEqual(validators.validate(self.spec(), {'records':[{'id':'2','summary':'Wrong scope'}]}).state, 'invalid')
        self.assertEqual(validators.validate(self.spec(), {'records':[{'id':'1'},{'id':'1'}]}).state, 'invalid')
    def test_arbitrary_validator_is_not_executable(self):
        spec = self.spec()
        spec = TaskSpec(**{**spec.__dict__, 'validator_id':'shell:rm'})
        self.assertEqual(ValidatorRegistry().validate(spec, {}).state, 'invalid')
