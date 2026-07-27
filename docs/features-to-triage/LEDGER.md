# Spec ledger

One row per spec. The id is allocated here and nowhere else; allocation is a
read-modify-write on this file, so it is taken serially even when the fleet is
running eight concurrent features.

| ID | Title | Brief | Status | Spec | Plan |
|---|---|---|---|---|---|
