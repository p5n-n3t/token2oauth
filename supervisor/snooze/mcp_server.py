"""Small scoped MCP facade and stdio transport for registered coordinators."""
import hmac
import json
from dataclasses import asdict
from snooze.events import EventFeed
from snooze.outbox import Outbox


class MCPFacade:
    def __init__(self,repository,control,token,projects):
        self.repo=repository;self.control=control;self.token=token;self.projects=tuple(projects)
        self.outbox=Outbox(repository)

    def call(self,tool,arguments,token):
        if not isinstance(token,str) or not hmac.compare_digest(token,self.token):raise PermissionError('Authentication required')
        if not isinstance(arguments,dict):raise ValueError('Object arguments required')
        project=arguments.get('project')
        if project not in self.projects:raise PermissionError('Project is outside registered scope')
        if tool=='snapshot':
            from snooze.control_views import task_row
            result={'project':self.repo.project(project),**self.repo.queue_page(project,limit=100)}
            if self.control:
                result.update(settings=self.control.scheduler.settings(project),accounts=self.control.registry.list_public(project))
            return result
        if tool=='events':return EventFeed(self.repo).read(project,arguments.get('after',0),arguments.get('limit',100))
        if tool=='incidents':return {'deliveries':self.outbox.list(project),'mode':'inbox-only'}
        if tool=='tasks':
            from snooze.control_views import task_row
            return self.repo.queue_page(project,limit=100)
        if tool=='task' and self.control:
            from snooze.control_views import managed_task_detail
            return managed_task_detail(self.control,project,arguments.get('task_id'))
        if tool=='control' and self.control:
            return asdict(self.control.apply(project,'mcp-coordinator',arguments['action'],arguments['target_id'],arguments.get('values',{}),arguments['expected_revision']))
        if tool=='register':
            self.outbox.register_coordinator(arguments['coordinator_id'],[project]);return {'registered':True}
        if tool=='acknowledge':return {'acknowledged':self.outbox.acknowledge(arguments['delivery_id'],arguments['coordinator_id'])}
        raise ValueError('Unknown/unsupported Snooze tool')

    def rpc(self,message):
        if not isinstance(message,dict):return {'jsonrpc':'2.0','id':None,'error':{'code':-32600,'message':'Object request required'}}
        id=message.get('id');method=message.get('method')
        if method=='notifications/initialized':return None
        try:
            if method=='initialize':result={'protocolVersion':'2025-03-26','capabilities':{'tools':{}},'serverInfo':{'name':'snooze','version':'0.2.0'}}
            elif method=='tools/list':
                fields={
                    'snapshot':{},'events':{'after':{'type':'integer','minimum':0},'limit':{'type':'integer','minimum':1,'maximum':200}},
                    'incidents':{},'tasks':{},'task':{'task_id':{'type':'string'}},
                    'control':{'action':{'type':'string','enum':['task-add','hold','approve','prioritize','resume','retry','cancel','reassign','account-config','account-test','policy-config','dispatch-pause','emergency-stop','coordinator-register','incident-ack']},'target_id':{'type':'string'},'values':{'type':'object'},'expected_revision':{'type':'integer','minimum':0}},
                    'register':{'coordinator_id':{'type':'string'}},'acknowledge':{'coordinator_id':{'type':'string'},'delivery_id':{'type':'string'}}}
                optional={'events':{'after','limit'},'control':{'values'}}
                result={'tools':[{'name':'snooze_'+name,'description':'Scoped Snooze '+name+'; delivery acceptance is not acknowledgment or resolution.',
                    'inputSchema':{'type':'object','properties':{'project':{'type':'string'},**properties},'required':['project',*[k for k in properties if k not in optional.get(name,set())]],'additionalProperties':False}}
                    for name,properties in fields.items()]}
            elif method=='tools/call':
                params=message['params']
                if not isinstance(params,dict):raise ValueError('Object parameters required')
                name=params['name']
                if not isinstance(name,str):raise ValueError('Tool name required')
                if not name.startswith('snooze_'):raise ValueError('Unknown tool')
                value=self.call(name[7:],params.get('arguments',{}),self.token)
                result={'content':[{'type':'text','text':json.dumps(value)}]}
            else:raise ValueError('Unsupported method')
            return {'jsonrpc':'2.0','id':id,'result':result}
        except (ValueError,KeyError,PermissionError,TypeError):
            return {'jsonrpc':'2.0','id':id,'error':{'code':-32602,'message':'Invalid or unauthorized Snooze request'}}

    def serve_stdio(self,input_stream,output_stream):
        for line in input_stream:
            if len(line)>65536:continue
            try:response=self.rpc(json.loads(line))
            except (ValueError,TypeError):response={'jsonrpc':'2.0','id':None,'error':{'code':-32700,'message':'Parse error'}}
            if response is not None:output_stream.write(json.dumps(response)+'\n');output_stream.flush()
