/** Alia-owned vocabularies, shared by runtime and database checks. */
export const CREDIT_OPERATION_STATUSES = ['admitted', 'settled', 'refunded'] as const;
export const CREDIT_PRICING_RULES = ['catalogue_price', 'base_rate', 'minimum'] as const;
export const CREDIT_PRICE_BOOK_SOURCES = ['oxy_catalogue_cache', 'catalogue_unavailable_base_rate'] as const;
