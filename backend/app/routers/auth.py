from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.database import supabase

router = APIRouter()


class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: dict


@router.post("/login", response_model=LoginResponse)
def login(req: LoginRequest):
    try:
        res = supabase.auth.sign_in_with_password({"email": req.email, "password": req.password})
        return LoginResponse(
            access_token=res.session.access_token,
            user=res.user.model_dump() if hasattr(res.user, "model_dump") else dict(res.user),
        )
    except Exception as e:
        raise HTTPException(status_code=401, detail="Invalid email or password")
