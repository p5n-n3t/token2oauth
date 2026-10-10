import unittest
from snooze.domain import AccountSnapshot, TaskSpec
from snooze.policy import Policy


class PolicyTests(unittest.TestCase):
    def task(self, **requirements):
        return TaskSpec('t','p',('record:1',),'fixture','h',{'model':'small','effort':'low',**requirements},{},'json-records',True)
    def account(self, quota=None, health='healthy', enabled=True, capabilities=None):
        return AccountSnapshot('a',enabled,2,100,capabilities or {'launch':{'supported':True}},('small',),quota,health)
    def test_unknown_quota_is_not_implicitly_free(self):
        self.assertFalse(Policy().evaluate(self.task(),self.account(),100).eligible)
        self.assertTrue(Policy({'allow_unknown_quota':True}).evaluate(self.task(),self.account(),100).eligible)
    def test_capacity_budget_health_and_disabled_are_hard_filters(self):
        quota={'value':2,'unit':'credits','source':'operator','expires_at':200}
        policy=Policy({'reserve':2})
        self.assertFalse(policy.evaluate(self.task(),self.account(quota),100).eligible)
        self.assertFalse(Policy({'allow_unknown_quota':True},occupied={'a':2}).evaluate(self.task(),self.account(),100).eligible)
        self.assertFalse(Policy({'allow_unknown_quota':True}).evaluate(self.task(),self.account(health='unavailable'),100).eligible)
        self.assertFalse(Policy({'allow_unknown_quota':True}).evaluate(self.task(),self.account(enabled=False),100).eligible)
    def test_quality_privacy_and_tools_cannot_be_ranked_away(self):
        config={'a':{'quality':'basic','privacy':['public'],'tools':[]}}
        policy=Policy({'allow_unknown_quota':True},account_configs=config)
        self.assertFalse(policy.evaluate(self.task(quality='advanced',tools=['search'],privacy='private'),self.account(),100).eligible)
    def test_native_bulk_disabled_by_default(self):
        policy=Policy({'allow_unknown_quota':True},account_configs={'a':{'adapter':'native'}})
        self.assertFalse(policy.evaluate(self.task(),self.account(),100).eligible)
