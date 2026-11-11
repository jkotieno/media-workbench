"""Transform reads a selected logical original without adopting a cache pathname."""
from sqlmodel import Session
from datetime import datetime
from hashlib import sha256
from pathlib import Path
from PIL import Image as Pillow
import pytest
from fastapi import HTTPException
from app.api.endpoints import transform
from app.models.image import Image
from app.models.project import Project
from app.models.storage import StorageLocation, StorageAsset
from app.services.media_paths import open_media_file, resolve_media_file


@pytest.fixture
def cached_original(session, tmp_path):
    logical = tmp_path / 'projects' / 'cached' / 'input' / 'source.png'
    actual = tmp_path / 'verified-copy.png'
    Pillow.new('RGB', (37, 29), (17, 93, 152)).save(actual)
    digest = sha256(actual.read_bytes()).hexdigest()
    project = Project(slug='cached', name='Cached', config_json={'storage_root_dir':str(tmp_path/'projects'), 'folders':['input','output']})
    image = Image(job_id=-1, path=str(logical), filename='source.png', file_exists=False, cloud_reference=True,
        extra_metadata={'studio_sync':{'original':{'sha256':digest,'size':actual.stat().st_size}}})
    owner = StorageLocation(name='Owned cache', bucket='fixture')
    session.add_all([project,image,owner]);session.commit()
    asset = StorageAsset(location_id=owner.id, image_id=image.id, remote_identity='selected-original', object_key='source.png', etag='fixture-etag',
        filename='source.png',kind='media',state='available',local_path=str(actual),sha256=digest,size=actual.stat().st_size,verified_at=datetime.utcnow())
    session.add(asset);session.commit()
    return image,asset,actual,digest


def test_transform_launch_reads_cached_bytes_and_keeps_logical_context(session,cached_original):
    image,asset,actual,digest=cached_original
    result=transform.get_transform_launch(image_path=image.path,session=session)
    assert result.source_image.path == image.path == result.resolved_source_path
    assert result.launch_image_path == image.path and result.project.slug == 'cached'
    assert (result.source_image.width,result.source_image.height,result.source_image.hash)==(37,29,digest)
    assert resolve_media_file(image,session) is None  # Writes still resolve the logical destination, never the cache.
    assert not Path(image.path).exists()
    assert sha256(actual.read_bytes()).hexdigest()==digest


@pytest.mark.parametrize('invalid',['revision','unverified','missing_digest','deleted','other_image'])
def test_transform_never_substitutes_unavailable_or_wrong_original(session,cached_original,invalid):
    image,asset,actual,digest=cached_original
    if invalid=='revision':image.extra_metadata={'studio_sync':{'original':{'sha256':'f'*64,'size':asset.size}}}
    elif invalid=='unverified':asset.verified_at=None
    elif invalid=='missing_digest':asset.sha256=None
    elif invalid=='deleted':image.is_deleted=True
    else:asset.image_id=None
    session.add_all([image,asset]);session.commit()
    with pytest.raises((HTTPException,FileNotFoundError)) as error:
        transform.get_transform_launch(image_path=image.path,session=session)
    if isinstance(error.value,HTTPException):assert error.value.status_code==404


def test_open_cached_original_holds_open_inode_across_unlink(session,cached_original):
    image,asset,actual,digest=cached_original
    physical,stream=open_media_file(session,image.path)
    assert physical==str(actual)
    actual.unlink()
    with stream:assert sha256(stream.read()).hexdigest()==digest


def test_existing_cloud_logical_file_keeps_its_read_path(session,cached_original):
    image,asset,actual,digest=cached_original
    logical=Path(image.path);logical.parent.mkdir(parents=True)
    logical.write_bytes(actual.read_bytes());image.file_exists=True
    asset.verified_at=None;session.add_all([image,asset]);session.commit()
    physical,stream=open_media_file(session,image.path)
    assert physical==image.path
    with stream:assert sha256(stream.read()).hexdigest()==digest


@pytest.mark.parametrize('save_mode',['new_copy','overwrite_current'])
def test_http_export_preserves_cached_source_and_logical_provenance(engine,session,cached_original,save_mode):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.db.database import get_session
    from tests_support.router_harness import make_session_override
    from io import BytesIO
    import json
    image,asset,actual,digest=cached_original
    rendered=BytesIO();Pillow.new('RGB',(37,29),(90,10,20)).save(rendered,format='PNG')
    app=FastAPI();app.include_router(transform.router,prefix='/transform')
    app.dependency_overrides[get_session]=make_session_override(engine)
    with TestClient(app) as client:
        launch=client.get('/transform/launch',params={'image_path':image.path})
        assert launch.status_code==200,launch.text
        assert launch.json()['source_image']['path']==image.path
        response=client.post('/transform/export',files={'file':('render.png',rendered.getvalue(),'image/png')},data={
            'document_json':json.dumps({'sourceImage':{'path':image.path,'hash':digest},'edit':{}}),
            'source_path':image.path,'launch_image_path':image.path,'save_mode':save_mode,
            'target_project_slug':'cached','target_folder':'output'})
        assert response.status_code==200,response.text
    assert response.json()['path']!=str(actual)
    assert sha256(actual.read_bytes()).hexdigest()==digest
    with Session(engine) as reader:
        exported=reader.get(Image,response.json()['id'])
        if save_mode=='new_copy':
            assert exported.extra_metadata['transform']['source_image_path']==image.path
            assert exported.extra_metadata['transform']['source_sha256']==digest


def test_logical_image_url_serves_original_not_retained_thumbnail(client,session,cached_original):
    image,asset,actual,digest=cached_original
    image.thumbnail_data=b'retained preview';session.add(image);session.commit()
    response=client.get('/api/v1/gallery/image/path',params={'path':image.path})
    assert response.status_code==200,response.text
    assert sha256(response.content).hexdigest()==digest
    assert response.headers['cache-control']=='private, no-store'
    preview=client.get(f'/api/v1/gallery/image/{image.id}/thumbnail')
    assert preview.status_code==200 and preview.content==b'retained preview'


@pytest.mark.parametrize('reason',['absent','revision'])
def test_logical_original_url_never_falls_back_to_preview(client,session,cached_original,reason):
    image,asset,actual,digest=cached_original
    image.thumbnail_data=b'retained preview'
    if reason=='absent':actual.unlink()
    else:image.extra_metadata={'studio_sync':{'original':{'sha256':'f'*64,'size':asset.size}}}
    session.add(image);session.commit()
    response=client.get('/api/v1/gallery/image/path',params={'path':image.path})
    assert response.status_code==404
    assert response.content!=b'retained preview'
