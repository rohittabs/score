# Quick Links (Alfred Workflow)

Save any long URL under a short custom name, then search, open, copy as a
clickable hyperlink, delete one, or clear everything, all from Alfred.

Data is stored in: `~/.alfred_quicklinks.json`
Scripts live in: `~/alfred-tools/`


## Keywords

### `linkadd Name, URL`
Saves a name -> URL mapping. Always use a comma between the name and the URL.

Example:
```
linkadd Practice Schedule, https://rohittabs.github.io/practice-schedule/
```

If you forget the `https://`, it gets added automatically.
If the name already exists, it overwrites the old URL.


### `link name`
Searches your saved links by name.

- Press **Enter** to open the matching link in your default browser.
- Hold **Cmd** and press **Enter** to instead copy it to your clipboard as a
  rich-text hyperlink (see `linkcopy` below for what that looks like when
  pasted).

Example:
```
link practice
```


### `linkcopy Name`
Copies the saved link to your clipboard as a rich-text hyperlink. The word
itself (e.g. "Practice Schedule") becomes the visible clickable text when
pasted into apps that support rich text: Notes, Mail, Word, Slack, WhatsApp
Desktop. Plain text fields (Terminal, most chat input boxes) will only show
the name, with no visible URL, since plain text can't carry a hyperlink.

Example:
```
linkcopy Practice Schedule
```

Note: the name must match exactly what you used in `linkadd`, including
capitalization and spacing.


### `linkdel Name`
Removes a saved link by exact name.

Example:
```
linkdel Practice Schedule
```

Hold **Cmd** and press **Enter** instead of a plain Enter to **delete every
saved link at once**. The text you typed after `linkdel` doesn't matter in
this case, it just needs to be non-empty for the keyword to fire, since the
keyword is set to "Argument Required." In practice this means you must type
`linkdel` followed by a space and at least one character before Cmd+Enter
will do anything, `linkdel` on its own with nothing after it will not fire.
There is no undo, so use this only when you actually mean to wipe everything.

Example (clears all links regardless of what's typed):
```
linkdel anything
```
then Cmd+Enter.


## Scripts

| File                  | Purpose                                                        |
|-----------------------|------------------------------------------------------------------|
| `add_link.py`         | Parses `Name, URL` and saves it to the JSON store                |
| `filter_links.py`     | Powers the `link` search filter; Enter opens the URL, Cmd+Enter passes the name through for copying as a hyperlink |
| `delete_link.py`      | Removes a single entry by exact name                              |
| `clear_all_links.py`  | Wipes every saved link, triggered by Cmd+Enter on `linkdel`       |
| `copy_link.py`        | Builds an HTML `<a>` tag and pushes it to the clipboard as rich text via AppleScript |

All scripts run with `/usr/bin/env python3` and take their argument via `argv`
(the Run Script / Script Filter actions are set to "with input as argv", and
the scripts use `"$1"` rather than `"{query}"`, since a literal `{query}`
substitution combined with a comma or pipe in the input can otherwise get
mishandled by the shell). `clear_all_links.py` takes no argument at all,
since it always clears everything regardless of input.


## Workflow wiring (for reference)

- `linkadd` Keyword -> Run Script (`add_link.py`) -> Post Notification
- `link` Script Filter:
  - plain connection -> Open URL
  - **Cmd** connection -> Run Script (`copy_link.py`) -> Post Notification
- `linkdel` Keyword:
  - plain connection -> Run Script (`delete_link.py`) -> Post Notification
  - **Cmd** connection -> Run Script (`clear_all_links.py`) -> Post Notification
- `linkcopy` Keyword -> Run Script (`copy_link.py`) -> Post Notification


## Data format

`~/.alfred_quicklinks.json` is a plain JSON object:

```json
{
  "Practice Schedule": "https://rohittabs.github.io/practice-schedule/",
  "Ukulele Course": "https://example.com/ukulele"
}
```

You can back this file up, sync it, or edit it by hand if needed, it's just
text.


## Troubleshooting

- **Nothing happens when you run a keyword:** open the workflow's Debugger
  (bug icon at the bottom of the workflow canvas) and re-run the keyword to
  see the exact command Alfred executed and any error output.
- **"Format: Name, URL" message appears instead of saving:** you're missing
  the comma between the name and the URL, or the Run Script action isn't set
  to receive input as argv.
- **Cmd+Enter does nothing on `linkdel` or `link`:** make sure you typed a
  space and at least one character after the keyword first (`Argument
  Required` keywords won't fire at all on an empty query, modifier or not).
- **`linkcopy` pastes as plain text instead of a clickable link:** the target
  app doesn't support rich text paste. Try Notes or Mail to confirm the
  workflow itself is working.
