# Third-party files

The page loads these files from the app itself instead of a CDN, so it works when jsDelivr or Google Fonts are slow or blocked and makes no third-party requests. The files are unchanged copies of the versions the page used from the CDN before.

| Files | Version | License | Source |
| --- | --- | --- | --- |
| `bootstrap/5.3.3/` (CSS + JS bundle) | 5.3.3 | MIT, `bootstrap/5.3.3/LICENSE` | `https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/` |
| `bootstrap-icons/1.11.3/` (CSS + fonts) | 1.11.3 | MIT, `bootstrap-icons/1.11.3/LICENSE` | `https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/` |
| `fonts/bricolage-grotesque-*.woff2` | Google Fonts v9 | SIL OFL 1.1, `fonts/OFL-BricolageGrotesque.txt` | `https://fonts.gstatic.com/s/bricolagegrotesque/v9/` |
| `fonts/source-sans-3-*.woff2` | Google Fonts v20 | SIL OFL 1.1, `fonts/OFL-SourceSans3.txt` | `https://fonts.gstatic.com/s/sourcesans3/v20/` |

`fonts/fonts.css` holds the `@font-face` rules Google Fonts served for the page's font request (latin and latin-ext subsets only), pointing at the local files.

To update a file, download the new version from the same source, replace it here, update the version in `index.html`, and refresh the checksums below.

## SHA-256 checksums

```text
0fb3e11bd57e896c5a512afd64864d28a37de45d19835016c87ca1ad19ead969  ./bootstrap-icons/1.11.3/LICENSE
f643d6fe7e679f9de3e16311600c5ef5cd6b098f7a3a8828fcc29255d2b33e62  ./bootstrap-icons/1.11.3/bootstrap-icons.min.css
bb1de989b83970f6f4e54de1cd974c5cba55b73582da5e1b225a6d0edf029483  ./bootstrap-icons/1.11.3/fonts/bootstrap-icons.woff
476adf42b40325098fcfa8b36ab3e769186bb4f6ce6a249753e2e1a9c22bf99e  ./bootstrap-icons/1.11.3/fonts/bootstrap-icons.woff2
8c14611ae41ac6fd543c13349f22188eb12c69b3e59105c5eca3925a8e4eca3e  ./bootstrap/5.3.3/LICENSE
3c8f27e6009ccfd710a905e6dcf12d0ee3c6f2ac7da05b0572d3e0d12e736fc8  ./bootstrap/5.3.3/css/bootstrap.min.css
0833b2e9c3a26c258476c46266e6877fc75218625162e0460be9a3a098a61c6c  ./bootstrap/5.3.3/js/bootstrap.bundle.min.js
4b5a7d8f37f5602621c8a8d7358a6a2e71317e6c231c661e15aef0275d3e07ba  ./fonts/OFL-BricolageGrotesque.txt
09746787287a289323b0ec3cff4d1a4a801331b82b7207c1e186f5d26619a392  ./fonts/OFL-SourceSans3.txt
1d04719f1325400ea4267e630dba29b02af87eb094d7d71d2e4d80a05479d07a  ./fonts/bricolage-grotesque-latin-ext.woff2
85f55a58a31e61a2e19e8bb25fed503181bf2a6b4cab76c589992cfaac377447  ./fonts/bricolage-grotesque-latin.woff2
7a00295dfd781d3991ed996b8461cc879d7f0e6caf28c43c53038de2e34c46c3  ./fonts/fonts.css
ed3571ea9ff752f1c846f1c9ad2b0006de42f478a2db9163a74db0729a4eb281  ./fonts/source-sans-3-latin-ext.woff2
587435ca9d90732b8c1ce4958222c6ad3ade2b875500188e1d318efbcb61f4c5  ./fonts/source-sans-3-latin.woff2
```
