from fastapi import APIRouter, HTTPException
from app.database import supabase
from app.models.lead import LeadCreate, LeadUpdate

router = APIRouter()


@router.get("", response_model=list)
def list_leads(status: str | None = None):
    q = supabase.table("leads").select("*, tracts(*), owners(*)").order("score", desc=True)
    if status:
        q = q.eq("status", status)
    res = q.execute()
    return res.data


@router.get("/{lead_id}")
def get_lead(lead_id: str):
    res = supabase.table("leads").select("*, tracts(*), owners(*)").eq("id", lead_id).single().execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Lead not found")
    return res.data


@router.post("", response_model=dict)
def create_lead(payload: LeadCreate):
    res = supabase.table("leads").insert(payload.model_dump()).execute()
    return res.data[0] if res.data else {}


@router.patch("/{lead_id}", response_model=dict)
def update_lead(lead_id: str, payload: LeadUpdate):
    data = payload.model_dump(exclude_unset=True)
    if not data:
        res = supabase.table("leads").select("*").eq("id", lead_id).single().execute()
        return res.data or {}
    res = supabase.table("leads").update(data).eq("id", lead_id).execute()
    return res.data[0] if res.data else {}
