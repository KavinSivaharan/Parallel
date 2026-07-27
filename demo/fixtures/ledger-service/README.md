# Ledger allocation service

This offline Python fixture allocates integer cents across accounts and exposes
a small request-normalization layer. It uses only the Python standard library.

Run the suite:

```bash
python3 -m unittest discover -s tests -v
```

The public request shape uses `account_id`. Historical clients may still send
the legacy `account` field; compatibility requirements are intentionally not
implemented in the initial fixture.
