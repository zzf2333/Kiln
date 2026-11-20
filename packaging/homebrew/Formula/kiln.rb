# Homebrew Formula for the Kiln CLI (`zzf2333/homebrew-tap`).
#
# Sync this file into `zzf2333/homebrew-tap` (or bump `url` + `sha256` when cutting
# a newer release such as `0.1.0`).
class Kiln < Formula
  desc "Local-first autonomous developer workbench and kilnd CLI"
  homepage "https://github.com/zzf2333/Kiln"
  # Checksum verified against published npm tarball `@zzf2333/kiln@0.0.1`.
  url "https://registry.npmjs.org/@zzf2333/kiln/-/kiln-0.0.1.tgz"
  sha256 "5fd8a51d37d548e16cf974b85e17491e9bbbeb499543d764c558e9974e7490e8"
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
