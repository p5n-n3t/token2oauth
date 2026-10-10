"""Explicit task packets: draft by default, bounded structured validators only."""
import re
from snooze.domain import TaskSpec


def add_packet(repository, project, packet, *, approved=False):
    allowed={'id','project_id','scope_keys','input_ref','input_hash','requirements','output_contract','validator_id','instructions','approved','dependencies'}
    if not isinstance(packet,dict) or set(packet)-allowed: raise ValueError('Unknown task packet fields')
    if not repository.project(project) or packet.get('project_id',project)!=project: raise ValueError('Task must belong to this project')
    if not isinstance(packet.get('id'),str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',packet['id']): raise ValueError('Invalid task ID')
    if packet.get('validator_id')!='json-records': raise ValueError('Only json-records is supported; no task-supplied executable validators')
    requirements=packet.get('requirements')
    if not isinstance(requirements,dict) or set(requirements)-{'model','effort','tools','privacy','quality','hard_write_scope'}: raise ValueError('Invalid task requirements')
    if 'hard_write_scope' in requirements and type(requirements['hard_write_scope']) is not bool:raise ValueError('Invalid hard write-scope requirement')
    if not isinstance(requirements.get('model'),str) or not requirements['model'] or len(requirements['model'])>160: raise ValueError('Explicit model required')
    if requirements.get('effort','low') not in ('low','medium','high'): raise ValueError('Invalid effort')
    if 'tools' in requirements and (not isinstance(requirements['tools'],list) or any(not isinstance(t,str) for t in requirements['tools'])): raise ValueError('Invalid tools')
    for key in ('privacy','quality'):
        if key in requirements and not isinstance(requirements[key],str): raise ValueError('Invalid '+key)
    contract=packet.get('output_contract')
    if not isinstance(contract,dict) or set(contract)-{'ids','fields'}: raise ValueError('Exact output contract required')
    for key in ('ids','fields'):
        values=contract.get(key)
        if not isinstance(values,list) or not values or len(values)>5000 or any(not isinstance(v,str) or not v or len(v)>160 for v in values) or len(values)!=len(set(values)): raise ValueError('Invalid output '+key)
    scopes=packet.get('scope_keys')
    if not isinstance(scopes,list) or not scopes or len(scopes)>5000: raise ValueError('Explicit scopes required')
    if {s[7:] for s in scopes if isinstance(s,str) and s.startswith('record:')} != set(contract['ids']): raise ValueError('Record scopes must equal assigned output IDs')
    instructions=packet.get('instructions')
    if not isinstance(instructions,str) or not instructions or len(instructions)>50000: raise ValueError('Instructions required (maximum 50000 characters)')
    if not isinstance(packet.get('input_ref'),str) or not packet['input_ref'] or len(packet['input_ref'])>1024: raise ValueError('Input reference required')
    if not isinstance(packet.get('input_hash'),str) or not re.fullmatch(r'[a-fA-F0-9]{64}',packet['input_hash']): raise ValueError('Input SHA256 required')
    dependencies=packet.get('dependencies',[])
    if not isinstance(dependencies,list) or any(not isinstance(d,str) or d==packet['id'] for d in dependencies): raise ValueError('Invalid dependencies')
    spec=TaskSpec(packet['id'],project,tuple(scopes),packet['input_ref'],packet['input_hash'],requirements,contract,'json-records',approved,tuple(dependencies))
    repository.add(spec,instructions)
    return repository.get(spec.id)
