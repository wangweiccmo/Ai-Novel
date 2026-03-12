from __future__ import annotations

import json

from fastapi import APIRouter, Request
from sqlalchemy import select

from app.api.deps import DbDep, UserIdDep, require_character_editor, require_project_editor, require_project_viewer
from app.core.errors import ok_payload
from app.db.utils import new_id
from app.models.character import Character
from app.schemas.characters import CharacterCreate, CharacterOut, CharacterUpdate
from app.services.search_index_service import schedule_search_rebuild_task
from app.services.vector_index_refresh_service import mark_vector_dirty

router = APIRouter()


@router.get("/projects/{project_id}/characters")
def list_characters(request: Request, db: DbDep, user_id: UserIdDep, project_id: str) -> dict:
    request_id = request.state.request_id
    require_project_viewer(db, project_id=project_id, user_id=user_id)
    rows = (
        db.execute(select(Character).where(Character.project_id == project_id).order_by(Character.updated_at.desc()))
        .scalars()
        .all()
    )
    return ok_payload(request_id=request_id, data={"characters": [CharacterOut.model_validate(r).model_dump() for r in rows]})


@router.post("/projects/{project_id}/characters")
def create_character(request: Request, db: DbDep, user_id: UserIdDep, project_id: str, body: CharacterCreate) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)
    row = Character(
        id=new_id(),
        project_id=project_id,
        name=body.name,
        role=body.role,
        profile=body.profile,
        notes=body.notes,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    schedule_search_rebuild_task(db=db, project_id=project_id, actor_user_id=user_id, request_id=request_id, reason="character_create")
    return ok_payload(request_id=request_id, data={"character": CharacterOut.model_validate(row).model_dump()})


@router.put("/characters/{character_id}")
def update_character(request: Request, db: DbDep, user_id: UserIdDep, character_id: str, body: CharacterUpdate) -> dict:
    request_id = request.state.request_id
    row = require_character_editor(db, character_id=character_id, user_id=user_id)

    if body.name is not None:
        row.name = body.name
    if body.role is not None:
        row.role = body.role
    if body.profile is not None:
        row.profile = body.profile
    if body.notes is not None:
        row.notes = body.notes
    if body.arc_stages is not None:
        row.arc_stages_json = json.dumps(body.arc_stages, ensure_ascii=False)
    if body.voice_samples is not None:
        row.voice_samples_json = json.dumps(body.voice_samples, ensure_ascii=False)

    db.commit()
    db.refresh(row)
    mark_vector_dirty(str(row.project_id), "character")
    schedule_search_rebuild_task(
        db=db, project_id=str(row.project_id), actor_user_id=user_id, request_id=request_id, reason="character_update"
    )
    return ok_payload(request_id=request_id, data={"character": CharacterOut.model_validate(row).model_dump()})


@router.delete("/characters/{character_id}")
def delete_character(request: Request, db: DbDep, user_id: UserIdDep, character_id: str) -> dict:
    request_id = request.state.request_id
    row = require_character_editor(db, character_id=character_id, user_id=user_id)
    db.delete(row)
    db.commit()
    schedule_search_rebuild_task(
        db=db, project_id=str(row.project_id), actor_user_id=user_id, request_id=request_id, reason="character_delete"
    )
    return ok_payload(request_id=request_id, data={})
