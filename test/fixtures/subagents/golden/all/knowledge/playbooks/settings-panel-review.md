# Playbook: settings-panel-review

Project notes to read before touching one product's settings panel or its old test scripts.

## Keep the settings dropdown chevron centered (settings-panel-chevron)

In the webapp settings panel, keep a single dropdown chevron vertically centered with a fixed gutter after the label, and check it at narrow widths in both themes.

Applies when: Changing the webapp settings panel.

## The old staging endpoint was retired (staging-endpoint-moved)

Requests to the previous staging endpoint fail since it was retired; tests and scripts written before the move need the new endpoint.

Applies when: Reading or reviving old test scripts.
