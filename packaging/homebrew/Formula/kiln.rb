# Homebrew Formula for the Kiln CLI (`zzf2333/homebrew-tap`).
#
# Pre-release setup:
#   1. Cut a `v<version>` GitHub Release with prebuilt zero-dependency binaries
#      (`kiln-v<version>-darwin-arm64`, `kiln-v<version>-darwin-x64`, `kiln-v<version>-linux-x64`)
#      and `SHA256SUMS`.
#   2. Replace the placeholder `sha256` values below with the real hashes from `SHA256SUMS`.
#   3. Sync this file into `zzf2333/homebrew-tap`.
class Kiln < Formula
  desc "Local-first autonomous developer workbench and kilnd CLI"
  homepage "https://github.com/zzf2333/Kiln"
  version "0.0.1"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "https://github.com/zzf2333/Kiln/releases/download/v#{version}/kiln-v#{version}-darwin-arm64"
      # TODO: Replace placeholder sha256 with real checksum from v0.0.1 SHA256SUMS.
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end

    on_intel do
      url "https://github.com/zzf2333/Kiln/releases/download/v#{version}/kiln-v#{version}-darwin-x64"
      # TODO: Replace placeholder sha256 with real checksum from v0.0.1 SHA256SUMS.
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/zzf2333/Kiln/releases/download/v#{version}/kiln-v#{version}-linux-x64"
      # TODO: Replace placeholder sha256 with real checksum from v0.0.1 SHA256SUMS.
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end

  def install
    binary = Dir["kiln-v*"].first
    raise "Expected prebuilt kiln binary in download staging directory" if binary.nil?

    bin.install binary => "kiln"
    bin.install_symlink "kiln" => "kl"
  end

  def caveats
    <<~EOS
      Kiln is distributed as a self-contained single binary (no Node.js runtime required).
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
