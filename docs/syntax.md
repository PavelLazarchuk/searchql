# Search syntax

This page is written for the people typing into a searchql search box. Copy it into your app's help page and replace the example fields (`status`, `label`, `created`, …) with your own, or generate the field list with `describeSchema()`.

## Words and phrases

| Type            | Finds                                     |
| --------------- | ----------------------------------------- |
| `leak`          | items containing "leak"                   |
| `memory leak`   | items containing both words, in any order |
| `"memory leak"` | items containing the exact phrase         |

## Filters

Write a field name, a colon and a value, with no spaces around the colon.

| Type                  | Finds                            |
| --------------------- | -------------------------------- |
| `status:open`         | status is open                   |
| `author:"Jane Doe"`   | quote values that contain spaces |
| `label:bug,ui`        | label is bug **or** ui           |
| `label:bug label:ui`  | label is bug **and** ui          |
| `name:jo*`            | name starts with "jo"            |
| `email:*@example.com` | email ends with "@example.com"   |
| `title:*cache*`       | title contains "cache"           |
| `assignee:@me`        | assigned to you                  |
| `has:assignee`        | has an assignee                  |
| `no:label`            | has no labels                    |

Field names and listed values ignore case: `Status:OPEN` is the same as `status:open`. Text values ignore case too, unless the field says otherwise.

## Numbers and dates

| Type                       | Finds                                |
| -------------------------- | ------------------------------------ |
| `comments:5`               | exactly 5                            |
| `comments:>5`              | more than 5 (also `>=`, `<`, `<=`)   |
| `comments:5..10`           | from 5 to 10, both included          |
| `comments:5..*`            | 5 or more                            |
| `created:2026-03-14`       | on that day                          |
| `created:2026-03`          | in March 2026                        |
| `created:2026`             | in 2026                              |
| `created:>2026-03-14`      | after that day                       |
| `created:2026-01..2026-03` | from January through March           |
| `created:today`            | today (also `yesterday`, `tomorrow`) |
| `created:-7d`              | in the last 7 days                   |
| `created:>-24h`            | in the last 24 hours                 |
| `created:<-1y`             | more than a year ago                 |

Relative dates count back with `-` (or forward with `+`) in minutes (`m` or `min`), hours (`h`), days (`d`), weeks (`w`), months (`mo`) and years (`y`). Dates without a time use your time zone.

## Combining

| Type                                       | Finds                                |
| ------------------------------------------ | ------------------------------------ |
| `status:open label:bug`                    | both must match                      |
| `label:bug OR label:crash`                 | either matches                       |
| `status:open (label:bug OR priority:high)` | parentheses group                    |
| `-label:wontfix`                           | everything without the wontfix label |
| `NOT draft:true`                           | the same as `-draft:true`            |
| `-(label:bug OR label:ui)`                 | neither                              |

Spaces between terms mean "and", and they bind tighter than `OR`: `a b OR c` means `(a b) OR c`. Write `AND`, `OR` and `NOT` in capitals; lowercase they are ordinary words.

## Shortcuts

Your app may define shortcuts such as `is:open` or `is:mine`. They stand for longer queries and work like any other filter: `is:open,draft`, `-is:draft`.

## Mistakes

A filter that isn't understood is reported with a hint, such as _Unknown filter "stauts" — did you mean status?_, and left out; the rest of the query still runs.
