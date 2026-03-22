from fastapi import APIRouter, HTTPException
from app.database import supabase
from app.models.tract import TractCreate

router = APIRouter()


@router.get("", response_model=list)
def list_tracts():
    res = supabase.table("tracts").select("*").execute()
    return res.data


@router.get("/{tract_id}")
def get_tract(tract_id: str):
    res = supabase.table("tracts").select("*").eq("id", tract_id).single().execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Tract not found")
    return res.data


@router.post("", response_model=dict)
def create_tract(payload: TractCreate):
    res = supabase.table("tracts").insert(payload.model_dump()).execute()
    return res.data[0] if res.data else {}
