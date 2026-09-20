"""Server-owned file library with stable canonical objects and workspace aliases."""
from __future__ import annotations
import base64, fnmatch, json, mimetypes, os, re, shutil, threading, uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from vulcan import config as cfg

_CONVERSATION_PREFIX='@conversation/'
_OBJECT_PREFIX='@object/'
_IGNORED_DIRECTORIES={'.git','.venv','.tox','.mypy_cache','.pytest_cache','__pycache__','node_modules','.objects','.meta'}
_LOCK=threading.RLock()

def root()->Path:
    cfg.ensure_dirs(); p=cfg.LIBRARY_DIR.resolve(); p.mkdir(parents=True,exist_ok=True); _objects_root().mkdir(parents=True,exist_ok=True); _meta_root().mkdir(parents=True,exist_ok=True); _ensure_readonly_view(); return p

def _objects_root(): return cfg.LIBRARY_DIR/'.objects'
def _meta_root(): return cfg.LIBRARY_DIR/'.meta'
def readonly_view_root()->Path:
    p=cfg.CONFIG_DIR/'.library-view'; _ensure_readonly_view(); return p

def _ensure_readonly_view():
    p=cfg.CONFIG_DIR/'.library-view'
    try:
        if p.is_symlink():
            if p.resolve()!=cfg.LIBRARY_DIR.resolve(): p.unlink(); p.symlink_to(cfg.LIBRARY_DIR.resolve(),target_is_directory=True)
        elif not p.exists(): p.symlink_to(cfg.LIBRARY_DIR.resolve(),target_is_directory=True)
    except OSError: pass

def owner_objects_root(chat_id:str)->Path:
    p=_objects_root()/'workspace'/str(chat_id); p.mkdir(parents=True,exist_ok=True); return p.resolve()

def _index_path(): return _meta_root()/'index.json'
def _load_index():
    try: data=json.loads(_index_path().read_text('utf-8')); return data if isinstance(data,dict) else {'version':1,'objects':{}}
    except Exception: return {'version':1,'objects':{}}
def _save_index(data):
    _meta_root().mkdir(parents=True,exist_ok=True); tmp=_index_path().with_suffix('.tmp'); tmp.write_text(json.dumps(data,indent=2,sort_keys=True),encoding='utf-8'); os.replace(tmp,_index_path())

def _identifier(relative:str)->str: return base64.urlsafe_b64encode(relative.encode()).decode().rstrip('=')
def _decode(identifier:str)->str:
    try:
        v=str(identifier).strip(); return base64.b64decode(v+'='*(-len(v)%4),altchars=b'-_',validate=True).decode()
    except Exception as exc: raise ValueError('Invalid library file identifier') from exc

def _object_meta(object_id:str): return _load_index().get('objects',{}).get(object_id)
def _object_payload(meta:dict)->Path: return (cfg.LIBRARY_DIR/meta['canonical_rel']).resolve()
def _find_object_by_payload(path:Path):
    resolved=path.resolve()
    for oid,meta in _load_index().get('objects',{}).items():
        try:
            if _object_payload(meta)==resolved: return oid,meta
        except OSError: pass
    return None

def _find_object_by_source(path:Path):
    try:
        st=path.stat(); absolute=str(path.absolute())
    except OSError:
        return None
    for oid,meta in _load_index().get('objects',{}).items():
        if meta.get('source_path') != absolute:
            continue
        if meta.get('source_dev') == st.st_dev and meta.get('source_ino') == st.st_ino:
            return oid,meta
    return None

def _resolve(identifier:str):
    relative=_decode(identifier)
    if relative.startswith(_OBJECT_PREFIX):
        oid=relative[len(_OBJECT_PREFIX):]; meta=_object_meta(oid)
        if not meta: raise FileNotFoundError('Library file not found')
        target=_object_payload(meta)
        if not (target.is_file() or target.is_dir()): raise FileNotFoundError('Library file not found')
        return target, relative
    if relative.startswith(_CONVERSATION_PREFIX):
        logical=PurePosixPath(relative[len(_CONVERSATION_PREFIX):]); parts=logical.parts
        if len(parts)<2 or parts[1] not in {'workspace','attachments'} or any(x in {'.','..'} for x in parts): raise FileNotFoundError('Library file not found')
        base=(cfg.CHATS_DIR/parts[0]/parts[1]).resolve(); lexical=base.joinpath(*parts[2:])
        if not lexical.absolute().is_relative_to(base.absolute()) or not (lexical.exists() or lexical.is_symlink()): raise FileNotFoundError('Library file not found')
        target=lexical.resolve()
        if not (target.is_file() or target.is_dir()): raise FileNotFoundError('Library file not found')
        return target, relative
    base=root(); target=(base/relative).resolve()
    if not target.is_relative_to(base) or not (target.is_file() or target.is_dir()): raise FileNotFoundError('Library file not found')
    return target,relative

def describe(path:Path)->dict:
    target=path.resolve()
    if not (target.is_file() or target.is_dir()): raise ValueError('File is outside the configured library')
    found=_find_object_by_payload(target)
    if found:
        oid,meta=found; stat=target.stat(); directory=target.is_dir()
        return {'file_id':_identifier(_OBJECT_PREFIX+oid),'name':meta['name'],'path':meta['visible_path'],'size':0 if directory else stat.st_size,'modified_at':datetime.fromtimestamp(stat.st_mtime,timezone.utc).isoformat(timespec='seconds'),'content_type':'inode/directory' if directory else mimetypes.guess_type(meta['name'])[0] or 'application/octet-stream','kind':'directory' if directory else 'file','source':meta['source'],'chat_id':meta['chat_id'],'canonical':True,'source_exists':Path(meta['source_path']).exists() or Path(meta['source_path']).is_symlink()}
    base=root()
    if target.is_relative_to(base): rel=target.relative_to(base).as_posix(); visible=rel; source='library'; chat_id=None
    elif target.is_relative_to(cfg.CHATS_DIR.resolve()):
        parts=target.relative_to(cfg.CHATS_DIR.resolve()).parts
        if len(parts)<2 or parts[1] not in {'workspace','attachments'}: raise ValueError('File is outside the configured library')
        chat_id=parts[0]; rel=_CONVERSATION_PREFIX+PurePosixPath(*parts).as_posix(); visible='conversations/'+PurePosixPath(*parts).as_posix(); source='workspace' if parts[1]=='workspace' else 'attachment'
    else: raise ValueError('File is outside the configured library')
    stat=target.stat(); directory=target.is_dir(); name=f'{chat_id}-workspace' if directory and source=='workspace' and len(parts)==2 else target.name
    return {'file_id':_identifier(rel),'name':name,'path':visible,'size':0 if directory else stat.st_size,'modified_at':datetime.fromtimestamp(stat.st_mtime,timezone.utc).isoformat(timespec='seconds'),'content_type':'inode/directory' if directory else mimetypes.guess_type(target.name)[0] or 'application/octet-stream','kind':'directory' if directory else 'file','source':source,**({'chat_id':chat_id} if chat_id else {})}

def _record_for_object(oid,meta):
    p=_object_payload(meta)
    if not (p.is_file() or p.is_dir()): return None
    return describe(p)

def _search(query,limit,*,allow_empty=False):
    cleaned=str(query or '').strip().lower(); terms=[x for x in re.split(r'\s+',cleaned) if x]
    if not terms and not allow_empty: return {'query':'','results':[],'count':0,'error':'A non-empty filename, folder, extension, or keyword query is required.'}
    multiple=len(terms)>1 and all('.' in PurePosixPath(t).name or any(c in t for c in '*?[') for t in terms)
    matches=[]; seen=set()
    def add_record(record):
        if not record or record['file_id'] in seen: return
        hay=(record['name']+' '+record['path']).lower(); name=record['name'].lower()
        if terms:
            mm=[fnmatch.fnmatch(name,t) or t in hay for t in terms]
            if not (any(mm) if multiple else all(mm)): return
        seen.add(record['file_id']); exact=int(bool(cleaned) and name==cleaned); prefix=int(bool(cleaned) and name.startswith(cleaned)); record['_rank']=(-exact,-prefix,name,record['path'].lower()); matches.append(record)
    def consider(path):
        if path.name.endswith('.tmp'): return
        try:
            # A promoted source and its canonical object are one Library item.
            if _find_object_by_source(path): return
            if path.is_symlink() and _find_object_by_payload(path.resolve()): return
            add_record(describe(path))
        except Exception: return
    def scan(base,directories):
        if not base.is_dir(): return
        for current,children,files in os.walk(base,followlinks=False):
            children[:]=sorted(c for c in children if c not in _IGNORED_DIRECTORIES)
            if directories:
                for c in children: consider(Path(current)/c)
            for f in files: consider(Path(current)/f)
    root()
    # Stable canonical objects remain searchable even if their source alias is moved/deleted.
    for oid,meta in _load_index().get('objects',{}).items(): add_record(_record_for_object(oid,meta))
    scan(root(),False)
    for cp in sorted(cfg.CHATS_DIR.iterdir()):
        if not cp.is_dir() or cp.is_symlink(): continue
        wp=cp/'workspace'
        if wp.is_dir(): consider(wp); scan(wp,True)
        scan(cp/'attachments',True)
    matches.sort(key=lambda x:x.pop('_rank')); maximum=max(1,min(int(limit),100)); return {'query':cleaned,'results':matches[:maximum],'count':len(matches)}

def search(query='',limit=20): return _search(query,limit)
def inventory_count(): return _search('',1,allow_empty=True)['count']
def upload_destination(filename):
    safe=Path(str(filename or 'file')).name
    if safe in ('','.','..'): safe='file'
    dest=root()/safe; n=2
    while dest.exists() or dest.with_name(dest.name+'.tmp').exists(): dest=root()/f'{Path(safe).stem} ({n}){Path(safe).suffix}'; n+=1
    return dest,f'/shared/library/{dest.name}',False

def _clone_canonical(source:Path,payload:Path):
    """Create a stable canonical object without mutating the source workspace.

    Regular files use hardlinks when possible (true zero-copy until either pathname
    is atomically replaced). Directories are mirrored recursively with hardlinked
    regular files, preserving the source workspace/git tree while giving Library an
    independent namespace that survives source moves/deletes.
    """
    if source.is_file():
        try: os.link(source,payload)
        except OSError: shutil.copy2(source,payload)
        return
    def copy_file(src,dst):
        try: os.link(src,dst); return dst
        except OSError: return shutil.copy2(src,dst)
    shutil.copytree(source,payload,symlinks=True,copy_function=copy_file)

def _promote(target:Path,relative:str):
    if not relative.startswith(_CONVERSATION_PREFIX): return target,relative
    logical=PurePosixPath(relative[len(_CONVERSATION_PREFIX):]); parts=logical.parts; chat_id,area=parts[0],parts[1]
    source_path=(cfg.CHATS_DIR/chat_id/area).joinpath(*parts[2:])
    existing=_find_object_by_source(source_path)
    if existing: return _object_payload(existing[1]),_OBJECT_PREFIX+existing[0]
    oid=uuid.uuid4().hex; bucket='workspace' if area=='workspace' else 'attachment'
    objdir=_objects_root()/bucket/chat_id/oid; objdir.mkdir(parents=True,exist_ok=False); payload=objdir/'payload'
    st=source_path.stat()
    meta={'id':oid,'name':(f'{chat_id}-workspace' if area=='workspace' and len(parts)==2 else source_path.name),'visible_path':'conversations/'+PurePosixPath(*parts).as_posix(),'source':'workspace' if area=='workspace' else 'attachment','chat_id':chat_id,'source_path':str(source_path.absolute()),'source_dev':st.st_dev,'source_ino':st.st_ino,'canonical_rel':payload.relative_to(cfg.LIBRARY_DIR).as_posix(),'created_at':datetime.now(timezone.utc).isoformat(timespec='seconds')}
    with _LOCK:
        try:
            _clone_canonical(source_path,payload)
            idx=_load_index(); idx.setdefault('objects',{})[oid]=meta; _save_index(idx)
        except Exception:
            shutil.rmtree(objdir,ignore_errors=True); raise
    return payload.resolve(),_OBJECT_PREFIX+oid

def attach(chat_id,file_id,destination=None):
    target,relative=_resolve(file_id); target,relative=_promote(target,relative); record=describe(target)
    raw=str(destination or record['name']).strip().replace('\\','/')
    if raw.startswith('/workspace/'): raw=raw[len('/workspace/'):]
    logical=PurePosixPath(raw)
    if not raw or logical.is_absolute() or any(x in ('..','.') for x in logical.parts): raise ValueError('Destination must be a path within the chat workspace')
    workspace=cfg.chat_workspace_dir(chat_id); link=workspace.joinpath(*logical.parts)
    if not link.parent.resolve().is_relative_to(workspace.resolve()): raise ValueError('Destination escapes the chat workspace')
    if link.exists() or link.is_symlink(): raise FileExistsError(f'Workspace path already exists: {logical}')
    # Attachments always use the dedicated read-only library view. Source aliases use
    # the canonical path directly and are writable only by their owning workspace mount.
    if relative.startswith(_OBJECT_PREFIX):
        oid=relative[len(_OBJECT_PREFIX):]; meta=_object_meta(oid); canonical_rel=PurePosixPath(meta['canonical_rel']); portable=(readonly_view_root()/canonical_rel).as_posix()
        canonical_id=_identifier(relative)
    else:
        rel=target.relative_to(root()); portable=(readonly_view_root()/rel).as_posix(); canonical_id=file_id
    link.parent.mkdir(parents=True,exist_ok=True); link.symlink_to(portable,target_is_directory=target.is_dir())
    return {'file_id':canonical_id,'name':record['name'],'path':f'/workspace/{logical.as_posix()}','size':record['size'],'kind':record['kind'],'read_only':True,'shared':True,**({'chat_id':record['chat_id']} if 'chat_id' in record else {})}

def translate_workspace_alias(path:Path)->Path|None:
    """Translate an absolute read-only-view symlink for host-side workspace tools."""
    try:
        if not path.is_symlink(): return None
        raw=Path(os.readlink(path))
        view=readonly_view_root()
        if raw.is_absolute() and str(raw).startswith(str(view)+os.sep):
            rel=raw.relative_to(view); target=(root()/rel).resolve()
            if target.is_relative_to(root()) and (target.exists() or target.is_symlink()): return target
    except Exception: return None
    return None

def is_shared_target(path:Path)->bool:
    try: describe(path)
    except Exception: return False
    return True
