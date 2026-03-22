from fastapi import APIRouter, HTTPException
from app.database import supabase
from app.models.drilling_permit import DrillingPermitCreate

router = APIRouter()


@router.get("", response_model=list)
def list_drilling_permits(county: str | None = None, state: str | None = None):
    q = supabase.table("drilling_permits").select("*").order("permit_date", desc=True)
    if county:
        q = q.eq("county", county)
    if state:
        q = q.eq("state", state)
    res = q.execute()
    return res.data


@router.get("/{permit_id}")
def get_drilling_permit(permit_id: str):
    res = supabase.table("drilling_permits").select("*").eq("id", permit_id).single().execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Permit not found")
    return res.data


@router.post("", response_model=dict)
def create_drilling_permit(payload: DrillingPermitCreate):
    res = supabase.table("drilling_permits").insert(payload.model_dump()).execute()
    return res.data[0] if res.data else {}
