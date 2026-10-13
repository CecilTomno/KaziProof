"""Small deterministic business rules shared by the demo API and tests."""

from __future__ import annotations

from typing import Any


def _is_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def calculate_invoice_summary(lines: list[dict[str, Any]]) -> dict[str, Any]:
    """Calculate a pre-tax invoice-ready summary using integer KSh minor units.

    quantity_milli is thousandths of a unit. Tax is intentionally zero here:
    this is not an eTIMS invoice and tax treatment is outside this prototype.
    Fractional line amounts round half up to the nearest cent.
    """
    if not isinstance(lines, list) or not lines:
        raise ValueError("Invoice summary needs at least one line")

    calculated_lines: list[dict[str, Any]] = []
    subtotal_minor = 0
    for index, line in enumerate(lines):
        if not isinstance(line, dict):
            raise ValueError(f"Line {index + 1} must be an object")
        description = line.get("description")
        quantity_milli = line.get("quantity_milli")
        unit_price_minor = line.get("unit_price_minor")
        if not isinstance(description, str) or not description.strip():
            raise ValueError(f"Line {index + 1} needs a description")
        if not _is_integer(quantity_milli) or quantity_milli <= 0:
            raise ValueError(f"Line {index + 1} quantity must be a positive integer in thousandths")
        if not _is_integer(unit_price_minor) or unit_price_minor < 0:
            raise ValueError(f"Line {index + 1} unit price must be a non-negative integer in minor units")

        line_total_minor = (quantity_milli * unit_price_minor + 500) // 1000
        subtotal_minor += line_total_minor
        calculated_lines.append({
            "description": description.strip(),
            "quantity_milli": quantity_milli,
            "unit_price_minor": unit_price_minor,
            "line_total_minor": line_total_minor,
        })

    return {
        "currency": "KES",
        "lines": calculated_lines,
        "subtotal_minor": subtotal_minor,
        "tax_minor": 0,
        "total_minor": subtotal_minor,
        "is_tax_invoice": False,
    }


def format_kes_minor(amount_minor: int) -> str:
    if not _is_integer(amount_minor):
        raise ValueError("Amount must be an integer in minor units")
    sign = "-" if amount_minor < 0 else ""
    whole, cents = divmod(abs(amount_minor), 100)
    return f"KSh {sign}{whole:,}.{cents:02d}"
