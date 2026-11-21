# Homebrew Cask template for the Kiln macOS menu bar app (`zzf2333/homebrew-tap`).
#
# Pre-release setup:
#   1. Build, Developer ID sign, and notarize `Kiln.app` (`apps/desktop`) on macOS.
#   2. Upload the notarized `.dmg` artifact to the corresponding `v<version>` GitHub Release.
#   3. Replace the placeholder `sha256` (and `url` if artifact naming changes)
#      with the real checksum before syncing to `zzf2333/homebrew-tap`.
cask "kiln-app" do
  arch arm: "arm64", intel: "x64"

  version "0.0.2"
  # SHA-256 digests from unsigned v0.0.2 GitHub Release DMGs; update after enabling Developer ID signing & notarization.
  sha256 arm:   "fb6262f3b9ac11d9c58039c0444566ed75028bda14ecf6441c6334bbb777982a",
         intel: "f3bdd4a749150db31c44b6fce596b69ad22d5730c3fdfd6f017673e78cf8255a"

  url "https://github.com/zzf2333/Kiln/releases/download/v#{version}/Kiln-v#{version}-darwin-#{arch}.dmg"
  name "Kiln"
  desc "Local-first autonomous developer workbench menu bar app"
  homepage "https://github.com/zzf2333/Kiln"

  depends_on macos: :ventura

  app "Kiln.app"

  # Preserves ~/.kiln tasks, ledgers, and worktrees; use `kiln uninstall --purge-data` to remove user data.
  zap trash: [
    "~/Library/Application Support/io.kiln.desktop",
    "~/Library/Caches/io.kiln.desktop",
    "~/Library/Preferences/io.kiln.desktop.plist",
    "~/Library/Saved Application State/io.kiln.desktop.savedState",
  ]
end
