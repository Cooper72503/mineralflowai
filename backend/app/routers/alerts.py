from fastapi import APIRouter
from app.database import supabase

router = APIRouter()


@router.get("", response_model=list)
def list_alerts():
    res = (
        supabase.table("drilling_permits")
        .select("*, tracts(*)")
        .eq("status", "active")
        .order("permit_date", desc=True)
        .limit(50)
        .execute()
    )
    return res.data
