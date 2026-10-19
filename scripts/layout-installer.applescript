on run arguments
    set mountPath to item 1 of arguments
    tell application "Finder"
        set installerFolder to folder (POSIX file mountPath as alias)
        open installerFolder
        tell container window of installerFolder
            set current view to icon view
            set toolbar visible to false
            set statusbar visible to false
            set pathbar visible to false
            -- 800 × 480 content area, plus the native title bar.
            set bounds to {160, 100, 960, 608}
        end tell
        set viewOptions to icon view options of container window of installerFolder
        set arrangement of viewOptions to not arranged
        set icon size of viewOptions to 144
        set text size of viewOptions to 14
        set label position of viewOptions to bottom
        set shows item info of viewOptions to false
        set shows icon preview of viewOptions to false
        set background picture of viewOptions to file ".background:background.tiff" of installerFolder
        set position of item "Conpera Switch.app" of installerFolder to {240, 302}
        set position of item "Applications" of installerFolder to {560, 302}
        update installerFolder without registering applications
        close container window of installerFolder
        open installerFolder
        delay 2
        close container window of installerFolder
    end tell
end run
