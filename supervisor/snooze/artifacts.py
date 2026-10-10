"""Bounded read-only GitHub saved-file collection; never fetch arbitrary URLs."""
import base64
import hashlib
import json
import re
import urllib.error
import urllib.request
from pathlib import PurePosixPath
from urllib.parse import quote
from snooze.notifications import NoRedirect


class GitHubArtifacts:
    def __init__(self, credentials=None, fetch=None):
        self.credentials=credentials; self.fetch=fetch or self._fetch

    def _fetch(self,url,headers):
        request=urllib.request.Request(url,headers=headers)
        try:
            with urllib.request.build_opener(NoRedirect()).open(request,timeout=5) as response:
                data=response.read(2*1024*1024+1)
                if len(data)>2*1024*1024: raise ValueError('Artifact response too large')
                return json.loads(data)
        except urllib.error.HTTPError as exc:
            if exc.code==404: return None
            raise

    def collect(self,config,attempt):
        repo=config.get('artifact_repo',''); prefix=config.get('artifact_prefix','')
        if not isinstance(repo,str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',repo): raise ValueError('An exact GitHub repository is required')
        path=PurePosixPath(prefix)
        if not prefix or path.is_absolute() or '..' in path.parts or '\\' in prefix or str(path)=='.': raise ValueError('Invalid artifact path prefix')
        task=attempt['task'];branch=attempt['data'].get('branch')
        if not isinstance(task,str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',task): raise ValueError('Invalid task ID')
        if not isinstance(branch,str) or not branch or len(branch)>256 or any(c in branch for c in ('\n','\r','\x00')): return None
        filename=str(path / (task+'.json'))
        url=f'https://api.github.com/repos/{repo}/contents/{quote(filename,safe="/")}?ref={quote(branch,safe="")}'
        headers={'Accept':'application/vnd.github+json','User-Agent':'Snooze-artifact-reader','X-GitHub-Api-Version':'2026-03-10'}
        if config.get('artifact_credential_ref'):
            if self.credentials is None: raise ValueError('Artifact credentials unavailable')
            headers['Authorization']='Bearer '+self.credentials.get(config['artifact_credential_ref'])
        response=self.fetch(url,headers)
        if response is None: return None
        if not isinstance(response,dict) or response.get('type')!='file' or response.get('encoding')!='base64' or response.get('path')!=filename or type(response.get('size')) is not int or not 0<=response['size']<=1024*1024: raise ValueError('Invalid saved artifact response')
        raw=base64.b64decode(response['content'].replace('\n',''),validate=True)
        if len(raw)>1024*1024: raise ValueError('Artifact too large')
        artifact=json.loads(raw)
        if not isinstance(artifact,dict) or artifact.get('task_id')!=task or artifact.get('attempt_id')!=attempt['id'] or type(artifact.get('generation')) is not int: raise ValueError('Artifact must attest its task, attempt and generation')
        return {**artifact,'source':'github-saved-file','sha256':hashlib.sha256(raw).hexdigest(),'git_blob_sha':response.get('sha'),
                'url':f'https://github.com/{repo}/blob/{quote(branch,safe="")}/{quote(filename,safe="/")}'}
