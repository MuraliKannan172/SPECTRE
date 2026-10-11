- `aircraft_in_area` and `vessels_in_area` take `group_by` and `stats`, so an
  MCP client can ask which airlines, countries, aircraft types or ship types
  dominate an area, or the average altitude or speed, over every match instead
  of estimating from the returned rows. Airlines come from the ICAO designator
  in each callsign (SWA1234 counts as SWA), so the breakdown works on feeds
  that report no operator; operator and type are counted only where the feed
  reports them; AIS ship type 0 ("not available") counts as unknown
  (quanticsoul4772, #1056).
