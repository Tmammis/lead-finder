paste this in your terminal and hit enter - autolanches the dashboard:

"/Users/terrymammis/Documents/ANTIGRAVITY.nosync/Lead workflows/Lead_finder_dashboard/start.command"


# Keeping it awake without babysitting it
The simplest way is the caffeinate command — it stops the Mac from sleeping while it runs:


## caffeinate -dimsu
Leave that running in a Terminal tab (alongside the dev server) and the Mac stays awake. Ctrl+C to release it.

Or set it permanently: System Settings → Lock Screen / Battery → Prevent automatic sleeping when the display is off (wording varies by macOS version).