- Give each Statens vegvesen camera its own ground height from Kartverket's
  keyless point-height API (CC BY 4.0) instead of one flat 150 m prior, so
  mountain-pass cameras no longer sit hundreds of metres below the terrain
  where neither the point-height prior nor the ground snap resolves. About 850
  of ~855 cameras get a height; the rest keep the old prior. Requests carry 20
  points, the most the API answers from its 1 m terrain model, eight at a
  time; a cold lookup takes about 6–13 s. Cameras over water use the water
  surface rather than the sea-floor depth the API returns there; for bridge
  cameras that is still below the deck. Heights are cached for good and misses
  for 6 h, so a refresh only asks about new or moved cameras. After a 429, a
  5xx or a network failure the lookup stops and backs off (Retry-After, else
  10 min). The lane waits at most 12 s from its start; a slower first lookup
  leaves the cameras it had not reached on the flat prior until the next
  15-minute refresh, and keeps filling the cache meanwhile.
  `CCTV_VEGVESEN_HEIGHTS=0` turns it off. Follow-up to #929 (trygvehhh, #945).
