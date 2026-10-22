
# app/main.py

import hashlib
import json
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import jwt
import redis
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from google import genai
from pwdlib import PasswordHash
from pydantic import BaseModel, Field
from qdrant_client import QdrantClient, models
from rank_bm25 import BM25Okapi
from sqlalchemy import String, create_engine
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    Session,
    mapped_column,
    sessionmaker,
)

load_dotenv()

# Configuration
COLLECTION = os.getenv("COLLECTION_NAME", "meridian_docs")
EMBED_MODEL = "gemini-embedding-001"
LLM_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
ABSTAIN_THRESHOLD = float(os.getenv("ABSTAIN_THRESHOLD", "0.015"))
TOP_K = 5

JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
ACCESS_TOKEN_MINUTES = int(os.getenv("ACCESS_TOKEN_MINUTES", "60"))
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "sqlite:////app/data/meridian.db",
)

if (
    not JWT_SECRET_KEY
    or JWT_SECRET_KEY == "replace_with_a_long_random_secret"
):
    raise RuntimeError(
        "Set a strong JWT_SECRET_KEY in .env before starting the API."
    )

# Database
engine_options = (
    {"connect_args": {"check_same_thread": False}}
    if DATABASE_URL.startswith("sqlite")
    else {}
)

engine = create_engine(DATABASE_URL, **engine_options)
SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    username: Mapped[str] = mapped_column(
        String(100), unique=True, index=True
    )
    password_hash: Mapped[str] = mapped_column(String(500))
    role: Mapped[str] = mapped_column(String(20))


password_hasher = PasswordHash.recommended()
bearer_scheme = HTTPBearer(auto_error=False)

# External services
qdrant = QdrantClient(
    url=os.getenv("QDRANT_URL", "http://qdrant:6333")
)
cache = redis.Redis.from_url(
    os.getenv("REDIS_URL", "redis://redis:6379/0"),
    decode_responses=True,
)

google_client = None
bm25 = None
bm25_docs = []
bm25_payloads = []


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def seed_demo_users(db: Session):
    """Create demo accounts if they do not already exist."""
    demo_users = [
        (
            os.getenv("DEMO_ENGINEER_USERNAME"),
            os.getenv("DEMO_ENGINEER_PASSWORD"),
            "engineer",
        ),
        (
            os.getenv("DEMO_ADMIN_USERNAME"),
            os.getenv("DEMO_ADMIN_PASSWORD"),
            "admin",
        ),
    ]

    for username, password, role in demo_users:
        if not username or not password:
            continue

        existing = (
            db.query(User)
            .filter(User.username == username)
            .first()
        )

        if existing is None:
            db.add(
                User(
                    username=username,
                    password_hash=password_hasher.hash(password),
                    role=role,
                )
            )

    db.commit()


# Document retrieval

def tokenize(text: str) -> list[str]:
    return re.findall(r"\b\w+\b", text.lower())


def build_bm25():
    global bm25, bm25_docs, bm25_payloads

    try:
        records, _ = qdrant.scroll(
            collection_name=COLLECTION,
            limit=10000,
            with_payload=True,
            with_vectors=False,
        )
    except Exception:
        records = []

    bm25_payloads = [
        point.payload
        for point in records
        if point.payload and point.payload.get("text")
    ]
    bm25_docs = [
        tokenize(payload["text"])
        for payload in bm25_payloads
    ]
    bm25 = BM25Okapi(bm25_docs) if bm25_docs else None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global google_client

    Base.metadata.create_all(bind=engine)

    with SessionLocal() as db:
        seed_demo_users(db)

    api_key = os.getenv("GEMINI_API_KEY")
    if api_key:
        google_client = genai.Client(api_key=api_key)

    build_bm25()
    yield


app = FastAPI(
    title="Meridian Engineering Copilot",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Request schemas

class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=200)


class AskRequest(BaseModel):
    question: str = Field(min_length=3, max_length=2000)
    top_k: int = Field(default=TOP_K, ge=1, le=10)


class RetrieveRequest(BaseModel):
    question: str = Field(min_length=3, max_length=2000)
    top_k: int = Field(default=TOP_K, ge=1, le=10)


# Authentication and authorization

def create_access_token(user: User) -> str:
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=ACCESS_TOKEN_MINUTES)

    payload = {
        "sub": user.username,
        "iat": now,
        "exp": expires_at,
    }

    return jwt.encode(
        payload,
        JWT_SECRET_KEY,
        algorithm=JWT_ALGORITHM,
    )


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(
        bearer_scheme
    ),
    db: Session = Depends(get_db),
) -> User:
    unauthorized = HTTPException(
        status_code=401,
        detail="Valid bearer token required.",
        headers={"WWW-Authenticate": "Bearer"},
    )

    if credentials is None:
        raise unauthorized

    try:
        payload = jwt.decode(
            credentials.credentials,
            JWT_SECRET_KEY,
            algorithms=[JWT_ALGORITHM],
        )
        username = payload.get("sub")
        if not username:
            raise unauthorized
    except jwt.InvalidTokenError:
        raise unauthorized

    user = (
        db.query(User)
        .filter(User.username == username)
        .first()
    )

    if user is None:
        raise unauthorized

    return user


def allowed_roles(user_role: str) -> list[str]:
    # Engineers can access engineer documents.
    # Admins can access engineer and admin documents.
    if user_role == "admin":
        return ["engineer", "admin"]

    return ["engineer"]


# RAG pipeline

def embed_query(question: str) -> list[float]:
    response = google_client.models.embed_content(
        model=EMBED_MODEL,
        contents=question,
        config={"task_type": "RETRIEVAL_QUERY"},
    )
    return response.embeddings[0].values


def retrieve(question: str, role: str, top_k: int):
    if google_client is None:
        raise HTTPException(
            status_code=503,
            detail="Set GEMINI_API_KEY in .env and restart the API.",
        )

    visible_roles = allowed_roles(role)
    vector = embed_query(question)

    role_conditions = [
        models.FieldCondition(
            key="role",
            match=models.MatchValue(value=visible_role),
        )
        for visible_role in visible_roles
    ]

    dense = qdrant.query_points(
        collection_name=COLLECTION,
        query=vector,
        query_filter=models.Filter(should=role_conditions),
        limit=top_k * 3,
        with_payload=True,
    ).points

    dense_ids = [str(point.id) for point in dense]
    payload_by_id = {
        str(point.id): point.payload
        for point in dense
    }

    # BM25 candidates are filtered by the authenticated user's role.
    lexical_ranked = []

    if bm25:
        scores = bm25.get_scores(tokenize(question))

        candidates = [
            (index, float(score))
            for index, score in enumerate(scores)
            if bm25_payloads[index].get("role") in visible_roles
        ]
        candidates.sort(key=lambda item: item[1], reverse=True)

        for index, _score in candidates[: top_k * 3]:
            payload = bm25_payloads[index]
            key = hashlib.md5(
                (
                    f'{payload["source"]}:'
                    f'{payload["chunk_index"]}'
                ).encode()
            ).hexdigest()

            lexical_ranked.append(key)
            payload_by_id[key] = payload

    # Reciprocal Rank Fusion combines dense and lexical rankings.
    rrf = {}

    for rank, key in enumerate(dense_ids, start=1):
        rrf[key] = rrf.get(key, 0.0) + 1.0 / (60 + rank)

    for rank, key in enumerate(lexical_ranked, start=1):
        rrf[key] = rrf.get(key, 0.0) + 1.0 / (60 + rank)

    ranked = sorted(
        rrf,
        key=rrf.get,
        reverse=True,
    )[:top_k]

    results = []

    for key in ranked:
        payload = payload_by_id.get(key)

        if payload and payload.get("role") in visible_roles:
            results.append(
                {
                    "text": payload["text"],
                    "source": payload["source"],
                    "title": payload["title"],
                    "role": payload["role"],
                    "score": rrf[key],
                }
            )

    return results


# API endpoints

@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "meridian-engineering-copilot",
    }


@app.post("/v1/auth/login")
def login(
    request: LoginRequest,
    db: Session = Depends(get_db),
):
    user = (
        db.query(User)
        .filter(User.username == request.username)
        .first()
    )

    if (
        user is None
        or not password_hasher.verify(
            request.password,
            user.password_hash,
        )
    ):
        raise HTTPException(
            status_code=401,
            detail="Incorrect username or password.",
        )

    return {
        "access_token": create_access_token(user),
        "token_type": "bearer",
        "expires_in": ACCESS_TOKEN_MINUTES * 60,
        "username": user.username,
        "role": user.role,
    }


@app.get("/v1/me")
def me(current_user: User = Depends(get_current_user)):
    return {
        "username": current_user.username,
        "role": current_user.role,
    }


@app.post("/v1/retrieve")
def retrieve_endpoint(
    request: RetrieveRequest,
    current_user: User = Depends(get_current_user),
):
    try:
        results = retrieve(
            request.question,
            current_user.role,
            request.top_k,
        )

        return {
            "results": [
                {
                    "source": result["source"],
                    "title": result["title"],
                    "score": result["score"],
                }
                for result in results
            ]
        }

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Retrieval failed: {exc}",
        ) from exc


@app.post("/v1/ask")
def ask(
    request: AskRequest,
    current_user: User = Depends(get_current_user),
):
    started = time.perf_counter()
    normalized = request.question.strip()

    # Role comes from the database-backed authenticated user,
    # never from a request body or a browser role selector.
    role = current_user.role

    cache_key = "ask:" + hashlib.sha256(
        f"{role}:{request.top_k}:{normalized.lower()}".encode()
    ).hexdigest()

    try:
        cached = cache.get(cache_key)
        if cached:
            result = json.loads(cached)
            result["cached"] = True
            return result
    except redis.RedisError:
        pass

    try:
        results = retrieve(
            normalized,
            role,
            request.top_k,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Retrieval failed: {exc}",
        ) from exc

    sources = [
        {
            "source": result["source"],
            "title": result["title"],
        }
        for result in results
    ]

    top_score = results[0]["score"] if results else 0.0

    # Abstain when retrieval has no results or insufficient confidence.
    if not results or top_score < ABSTAIN_THRESHOLD:
        result = {
            "answer": "I'm not sure based on the available documents.",
            "citations": sources,
            "abstained": True,
            "cached": False,
            "latency_ms": round(
                (time.perf_counter() - started) * 1000,
                2,
            ),
        }

    else:
        context = "\n\n".join(
            (
                f'[Source: {item["source"]}; '
                f'Title: {item["title"]}]\n{item["text"]}'
            )
            for item in results
        )

        prompt = f"""You are Meridian Engineering Copilot.
Answer only using the supplied documentation.
If the context does not answer the question, say you are not sure.
Cite factual claims with [source: filename].
Do not invent sources.

Question: {normalized}

Documentation:
{context}
"""

        try:
            response = google_client.models.generate_content(
                model=LLM_MODEL,
                contents=prompt,
            )

            answer = (response.text or "").strip()
            if not answer:
                answer = "I'm not sure based on the available documents."

        except Exception as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Gemini generation failed: {exc}",
            ) from exc

        result = {
            "answer": answer,
            "citations": sources,
            "abstained": answer.lower().startswith("i'm not sure"),
            "cached": False,
            "latency_ms": round(
                (time.perf_counter() - started) * 1000,
                2,
            ),
        }

    try:
        cache.setex(cache_key, 300, json.dumps(result))
    except redis.RedisError:
        pass

    return result
