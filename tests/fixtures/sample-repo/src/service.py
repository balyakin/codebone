def create_invoice(user_id: str, amount: int) -> dict:
    return {"user_id": user_id, "amount": amount, "status": "draft"}
