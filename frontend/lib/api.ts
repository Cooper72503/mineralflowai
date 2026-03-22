const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

export async function api<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    (headers as Record<string, string>)["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Request failed");
  }
  return res.json();
}

export const auth = {
  login: (email: string, password: string) =>
    api<{ access_token: string; user: Record<string, unknown> }>(
      "/api/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }
    ),
};

export const leadsApi = {
  list: (status?: string) =>
    api<Lead[]>(
      status ? `/api/leads?status=${encodeURIComponent(status)}` : "/api/leads"
    ),
  get: (id: string) => api<LeadDetail>(`/api/leads/${id}`),
};

export const documentsApi = {
  list: () => api<Document[]>("/api/documents"),
};

export const alertsApi = {
  list: () => api<Alert[]>("/api/alerts"),
};

export type Lead = {
  id: string;
  tract_id: string | null;
  owner_id: string | null;
  score: number;
  status: string;
  notes: string | null;
  created_at: string;
  tracts?: { id: string; name: string; county: string | null } | null;
  owners?: { id: string; name: string; email: string | null } | null;
};

export type LeadDetail = Lead;

export type Document = {
  id: string;
  name: string;
  file_path: string;
  extraction_status: string;
  created_at: string;
};

export type Alert = {
  id: string;
  permit_number: string;
  county: string | null;
  state: string | null;
  status: string;
  permit_date: string | null;
  tracts?: { id: string; name: string } | null;
};
