-- Store the bounded relation projection with its original delivery; links remain in entry_links.
ALTER TABLE context_deliveries ADD COLUMN relation_delivery_json TEXT;
ALTER TABLE context_deliveries ADD COLUMN relation_character_budget INTEGER;
ALTER TABLE context_deliveries ADD COLUMN relation_edge_cap INTEGER;
