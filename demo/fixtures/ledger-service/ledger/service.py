"""Request boundary for the allocation library."""

from typing import Any

from .allocation import allocate_cents


def allocate_request(payload: dict[str, Any]) -> dict[str, Any]:
    """Validate an API-shaped payload and return allocations."""
    total_cents = payload.get("total_cents")
    accounts = payload.get("accounts")
    if not isinstance(total_cents, int):
        raise ValueError("total_cents must be an integer")
    if not isinstance(accounts, list):
        raise ValueError("accounts must be a list")

    account_ids: list[str] = []
    for account in accounts:
        if not isinstance(account, dict) or not isinstance(account.get("account_id"), str):
            raise ValueError("each account must contain account_id")
        account_ids.append(account["account_id"])

    return {
        "total_cents": total_cents,
        "allocations": allocate_cents(total_cents, account_ids),
    }
