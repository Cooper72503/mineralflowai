from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import settings
from app.routers import auth, owners, tracts, documents, ownership_history, drilling_permits, leads, alerts

app = FastAPI(title="Mineral Intelligence AI API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(owners.router, prefix="/api/owners", tags=["owners"])
app.include_router(tracts.router, prefix="/api/tracts", tags=["tracts"])
app.include_router(documents.router, prefix="/api/documents", tags=["documents"])
app.include_router(ownership_history.router, prefix="/api/ownership-history", tags=["ownership-history"])
app.include_router(drilling_permits.router, prefix="/api/drilling-permits", tags=["drilling-permits"])
app.include_router(leads.router, prefix="/api/leads", tags=["leads"])
app.include_router(alerts.router, prefix="/api/alerts", tags=["alerts"])


@app.get("/api/health")
def health():
    return {"status": "ok"}
