from fastapi import APIRouter, HTTPException, UploadFile
from app.database import supabase
from app.models.document import DocumentCreate
import uuid
import os

router = APIRouter()

UPLOAD_DIR = os.getenv("UPLOAD_DIR", "./uploads")


@router.get("", response_model=list)
def list_documents():
    res = supabase.table("documents").select("*").order("created_at", desc=True).execute()
    return res.data


@router.get("/{document_id}")
def get_document(document_id: str):
    res = supabase.table("documents").select("*").eq("id", document_id).single().execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Document not found")
    return res.data


@router.post("", response_model=dict)
def create_document(payload: DocumentCreate):
    res = supabase.table("documents").insert(payload.model_dump()).execute()
    return res.data[0] if res.data else {}


@router.post("/upload", response_model=dict)
async def upload_document(file: UploadFile, tract_id: str | None = None, owner_id: str | None = None):
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    ext = os.path.splitext(file.filename or "file")[1] or ".pdf"
    path = f"{UPLOAD_DIR}/{uuid.uuid4()}{ext}"
    content = await file.read()
    with open(path, "wb") as f:
        f.write(content)
    payload = DocumentCreate(name=file.filename or "Upload", file_path=path, tract_id=tract_id, owner_id=owner_id)
    res = supabase.table("documents").insert(payload.model_dump()).execute()
    return res.data[0] if res.data else {}
