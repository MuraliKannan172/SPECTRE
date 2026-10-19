- Harden the Tarktee (Estonia) DATEX2 camera catalog fetches: refuse redirects,
  cancel both response streams when either request fails or overflows the 4 MB
  byte cap, extend the dual-XML fetch deadline to 15 s, and deduplicate camera
  IDs before per-pack prioritization (yaka0007, #1233).
