# Homebrew Cask template for the Kiln macOS menu bar app (`zzf2333/homebrew-tap`).
#
# Pre-release setup:
#   1. Build, Developer ID sign, and notarize `Kiln.app` (`apps/desktop`) on macOS.
#   2. Upload the notarized `.dmg` artifact to the corresponding `v<version>` GitHub Release.
#   3. Replace the placeholder `sha256` (and `url` if artifact naming changes)
#      with the real checksum before syncing to `zzf2333/homebrew-tap`.
cask "kiln-app" do
  arch arm: "arm64", intel: "x64"

  version "0.0.7"
  # Placeholder SHA-256 digests; update with checksums from the signed v0.0.7 GitHub Release DMGs.
  sha256 arm:   "9bf9cb9c3dab5217a9487b43ff27df1ba086169bfb5108d159fe095c4406882f",
         intel: "d442fc5b3fcaec254b4eb0833c2dcff815645e5489f1236c911f3d893ae58f97"

  url "https://github.com/zzf2333/Kiln/releases/download/v#{version}/Kiln-v#{version}-darwin-#{arch}.dmg"
  name "Kiln"
  desc "Local-first autonomous developer workbench menu bar app"
  homepage "https://github.com/zzf2333/Kiln"

  depends_on macos: :ventura
  conflicts_with formula: "kiln"

  app "Kiln.app"
  binary "#{appdir}/Kiln.app/Contents/Resources/kiln-runtime/bin/kiln"
  binary "#{appdir}/Kiln.app/Contents/Resources/kiln-runtime/bin/kl"

  # Preserves ~/.kiln tasks, ledgers, and worktrees; use `kiln uninstall --purge-data` to remove user data.
  zap trash: [
    "~/Library/Application Support/Kiln",
    "~/Library/Logs/Kiln",
    "~/Library/Preferences/io.kiln.desktop.plist",
    "~/Library/Saved Application State/io.kiln.desktop.savedState",
  ]
end
