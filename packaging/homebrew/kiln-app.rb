# Homebrew Cask template for the Kiln macOS menu bar app (`zzf2333/homebrew-tap`).
#
# Pre-release setup:
#   1. Build, Developer ID sign, and notarize `Kiln.app` (`apps/desktop`) on macOS.
#   2. Upload the notarized `.dmg` artifact to the corresponding `v<version>` GitHub Release.
#   3. Replace the placeholder `sha256` (and `url` if artifact naming changes)
#      with the real checksum before syncing to `zzf2333/homebrew-tap`.
cask "kiln-app" do
  version "0.1.0"
  # TODO: Replace placeholder sha256 with the signed & notarized Kiln DMG hash.
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/zzf2333/Kiln/releases/download/v#{version}/Kiln-#{version}-universal.dmg"
  name "Kiln"
  desc "Local-first autonomous developer workbench menu bar app"
  homepage "https://github.com/zzf2333/Kiln"

  depends_on macos: ">= :ventura"

  app "Kiln.app"

  # Preserves ~/.kiln tasks, ledgers, and worktrees; use `kiln uninstall --purge-data` to remove user data.
  zap trash: [
    "~/Library/Application Support/io.kiln.desktop",
    "~/Library/Caches/io.kiln.desktop",
    "~/Library/Preferences/io.kiln.desktop.plist",
    "~/Library/Saved Application State/io.kiln.desktop.savedState",
  ]
end
