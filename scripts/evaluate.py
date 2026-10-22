import os
import time
import requests

API_URL = os.getenv("API_URL", "http://localhost:8000/v1/retrieve")
TOP_K = 5

TEST_CASES = [
    ("How do I create a FastAPI application?", "engineer", "engineer/first-steps.md"),
    ("How do I define a GET endpoint?", "engineer", "engineer/first-steps.md"),
    ("What is a path operation?", "engineer", "engineer/first-steps.md"),
    ("How do I return JSON from an endpoint?", "engineer", "engineer/first-steps.md"),
    ("Can a path operation use async def?", "engineer", "engineer/first-steps.md"),
    ("How do I start a FastAPI application?", "engineer", "engineer/first-steps.md"),
    ("What does FastAPI provide for API development?", "engineer", "engineer/fastapi-intro.md"),
    ("What is FastAPI built on?", "engineer", "engineer/fastapi-intro.md"),
    ("How does FastAPI generate API documentation?", "engineer", "engineer/fastapi-intro.md"),
    ("What is a FastAPI path parameter?", "engineer", "engineer/first-steps.md"),
    ("How can I deploy a FastAPI application manually?", "admin", "admin/deployment.md"),
    ("What should I consider when running a server in production?", "admin", "admin/deployment.md"),
    ("How do I run a FastAPI application with a server?", "admin", "admin/deployment.md"),
    ("What is needed to deploy a FastAPI application?", "admin", "admin/deployment.md"),
    ("How can I prepare a FastAPI application for production?", "admin", "admin/deployment.md"),
]


def main():
    rows = []
    total_precision = 0.0
    total_latency = 0.0

    for question, role, expected_source in TEST_CASES:
        started = time.perf_counter()
        try:
            response = requests.post(
                API_URL,
                json={"question": question, "role": role, "top_k": TOP_K},
                timeout=90,
            )
            response.raise_for_status()
            results = response.json()["results"]
            latency = (time.perf_counter() - started) * 1000

            # Precision@5 counts relevant retrieved chunks, not citations.
            relevant = sum(
                1 for item in results
                if item["source"] == expected_source
            )
            precision = relevant / TOP_K

            total_precision += precision
            total_latency += latency
            rows.append((question[:38], role, precision, latency, "OK"))
        except Exception as exc:
            latency = (time.perf_counter() - started) * 1000
            total_latency += latency
            rows.append((question[:38], role, 0.0, latency, f"ERROR: {str(exc)[:25]}"))

    print(f"\n{'Question':40} {'Role':8} {'P@5':>6} {'Latency ms':>12} Status")
    print("-" * 100)
    for question, role, precision, latency, status in rows:
        print(f"{question:40} {role:8} {precision:6.2f} {latency:12.1f} {status}")

    count = len(TEST_CASES)
    print("-" * 100)
    print(f"Queries: {count}")
    print(f"Mean Precision@5: {total_precision / count:.3f}")
    print(f"Mean latency: {total_latency / count:.1f} ms")


if __name__ == "__main__":
    main()