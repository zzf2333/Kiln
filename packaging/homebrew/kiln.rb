# Homebrew Formula template for the Kiln CLI (`zzf2333/homebrew-tap`).
#
# Pre-release setup:
#   1. Publish `@zzf2333/kiln` to npm (or attach a standalone CLI tarball to a
#      GitHub Release) and update `url` below.
#   2. Replace the placeholder `sha256` with the real checksum from `SHA256SUMS`
#      before publishing this formula to `zzf2333/homebrew-tap`.
class Kiln < Formula
  desc "Local-first autonomous developer workbench and kilnd CLI"
  homepage "https://github.com/zzf2333/Kiln"
  # TODO: Update `url` and `sha256` after the first public release tarball is published.
  url "https://registry.npmjs.org/@zzf2333/kiln/-/kiln-0.1.0.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "Apache-2.0"

  depends_on "node@22"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      Kiln does not install or enable any background startup service automatically.

      Quick start:
        kiln doctor
        kiln up

      Optional OS startup service (opt-in):
        kiln service install
    EOS
  end

  test do
    assert_match "Kiln CLI", shell_output("#{bin}/kiln --help")
    assert_match version.to_s, shell_output("#{bin}/kiln --version")
    assert_match "Kiln CLI", shell_output("#{bin}/kl --help")
  end
end
