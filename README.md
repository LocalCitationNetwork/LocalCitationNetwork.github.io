# Local-Citation-Network

This web app aims to help scientists with their literature review using metadata from [Microsoft Academic](https://academic.microsoft.com/) and [Crossref](https://crossref.org/). Academic papers cite one another, thus creating a [citation network (= graph)](https://en.wikipedia.org/wiki/Citation_graph). Each node (= vertex) represents an article and each edge (= link / arrow) represents a citation, that is a directed link between two articles. As papers can only cite older papers, in theory the citation network is a [directed acyclic graph](https://en.wikipedia.org/wiki/Directed_acyclic_graph). Citation graphs are a topic of [bibliometrics](https://en.wikipedia.org/wiki/Bibliometrics).

This web app visualizes subsets of the global citation network that I call "local citation networks", defined by citations of a given set of input articles. In addition, the cited references missing in the set of input articles are suggested for further review.

## Open source contributions

This project is open source (GPL-3). I don't have much more time to work on this project, so I'm actively looking for help and contributors! Bugfixes are always welcome but please contact me before any large pull-requests so we can coordinate.

## FAQ

For more details check out the FAQs in the web app!