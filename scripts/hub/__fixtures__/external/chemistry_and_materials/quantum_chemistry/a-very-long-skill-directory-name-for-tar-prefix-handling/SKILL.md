---
name: long-name
description: Exercises the ustar prefix field with a path over one hundred bytes.
metadata:
  skill-author: Fixture Author
---

# long-name

The directory name is longer than a tar header's name field, so the snapshot
reader and writer have to split it into prefix and name.
