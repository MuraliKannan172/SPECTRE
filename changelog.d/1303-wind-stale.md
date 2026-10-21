- `get_wind` says when it answers from a stale forecast run. When the model
  upstream fails, the wind proxy keeps serving its last run; the tool now
  returns `stale` and adds "(forecast may be stale)" instead of giving old
  wind as current (quanticsoul4772, #1303).
