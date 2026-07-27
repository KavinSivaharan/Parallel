"""Deterministic allocation of integer currency units."""


def allocate_cents(total_cents: int, account_ids: list[str]) -> list[dict[str, int | str]]:
    """Split a non-negative amount across unique accounts."""
    if total_cents < 0:
        raise ValueError("total_cents must be non-negative")
    if not account_ids:
        raise ValueError("at least one account is required")
    if len(set(account_ids)) != len(account_ids):
        raise ValueError("account IDs must be unique")

    per_account = total_cents // len(account_ids)
    return [
        {"account_id": account_id, "amount_cents": per_account}
        for account_id in account_ids
    ]
