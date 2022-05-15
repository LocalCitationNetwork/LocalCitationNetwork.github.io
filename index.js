/* Local Citation Network v0.99 (GPL-3) */
/* by Tim Woelfle */
/* https://timwoelfle.github.io/Local-Citation-Network */

/* global fetch, localStorage, vis, Vue, Buefy */

'use strict'

const arrSum = arr => arr.reduce((a, b) => a + b, 0)
const arrAvg = arr => arrSum(arr) / arr.length

/* Semantic Scholar API */

async function semanticScholarWrapper (expression, responseFunction, getCitations = false) {
  const responses = []
  for (const id of expression.split(',')) {
    const response = await semanticScholarPaper(id, getCitations)
    if (response) responses.push(response)
  }
  responseFunction(responses)
}

function semanticScholarPaper (id, getCitations) {
  let fields = 'externalIds,title,abstract,venue,year,citationCount,authors,references.paperId'
  if (getCitations) fields += ',citations.paperId'
  return fetch('https://api.semanticscholar.org/graph/v1/paper/' + id + '?fields=' + fields).then(response => {
    return response.json()
  }).then(response => {
    if (response.error) throw (response.error)
    return response
  }).catch(error => {
    vm.errorMessage('Error while processing data through Semantic Scholar API for ' + id + ': ' + error + '<br>Too rapid requests can cause errors. Repeat request after a short break or switch API.')
    return false
  })
}

function semanticScholarResponseToArticleArray (data, sourceReferences) {
  return data.map(function (article) {
    const doi = article.externalIds && article.externalIds.DOI && article.externalIds.DOI.toUpperCase()

    return {
      id: article.paperId,
      // Semantic Scholar returns reference lists of papers not in order of references in original publication
      // Nonetheless, when the input is a listOfDOIs (i.e. file / bookmarklet), the order can be recovered through sourceReferences
      numberInSourceReferences: (doi && sourceReferences.length) ? sourceReferences.indexOf(doi) + 1 : undefined,
      doi: doi,
      title: article.title,
      authors: article.authors.map(author => {
        const lastSpace = author.name.lastIndexOf(' ')
        return { LN: author.name.substr(lastSpace + 1), FN: author.name.substr(0, lastSpace) }
      }),
      year: article.year,
      journal: article.venue,
      references: (article.references) ? article.references.map(x => x.paperId) : [],
      citations: (article.citations) ? article.citations.map(x => x.paperId).filter(Boolean) : [],
      citationsCount: article.citationCount,
      abstract: article.abstract
    }
  // Remove duplicates (e.g. in references of 10.1111/J.1461-0248.2009.01285.X, eebf363bc78ca7bc16a32fa339004d0ad43aa618 came up twice)
  }).reduce((data, article) => {
    const ids = data.map(x => x.id)
    if (!ids.includes(article.id)) data.push(article)
    return data
  }, [])
}

/* OpenAlex API */

async function openAlexWrapper (expression, responseFunction) {
  const responses = []
  for (const id of expression.split(',')) {
    const response = await openAlexWorks(id)
    if (response) responses.push(response)
  }
  responseFunction(responses)
}

function openAlexWorks (id) {
  return fetch('https://api.openalex.org/works/' + id + '?mailto=local-citation-network@timwoelfle.de').then(response => {
    if (response.status !== 200) throw (response.statusText)
    return response.json()
  }).catch(error =>
    vm.errorMessage('Error while processing data through OpenAlex API for ' + id + ': ' + error, false)
  )
}

function openAlexResponseToArticleArray (data, sourceReferences) {
  return data.map(function (article) {
    const doi = (article.doi) ? article.doi.replace('https://doi.org/', '').toUpperCase() : undefined

    return {
      id: article.id.replace('https://openalex.org/', ''),
      // OpenAlex returns reference lists of papers as arrays not by order of references in original publication
      // Nonetheless, when the input is a listOfDOIs (i.e. file / bookmarklet), the order can be recovered through sourceReferences
      numberInSourceReferences: (doi && sourceReferences.length) ? sourceReferences.indexOf(doi) + 1 : undefined,
      doi: doi,
      title: article.display_name,
      authors: article.authorships.map(authorship => {
        const display_name = authorship.author.display_name; const lastSpace = display_name.lastIndexOf(' ')
        return { LN: display_name.substr(lastSpace + 1), FN: display_name.substr(0, lastSpace), affil: authorship.institutions.display_name || undefined }
      }),
      year: article.publication_year,
      journal: article.host_venue.display_name || article.host_venue.publisher,
      references: (article.referenced_works || []).map(x => x.replace('https://openalex.org/', '')),
      citationsCount: article.cited_by_count,
      abstract: (article.abstract_inverted_index) ? revertAbstractFromInvertedIndex(article.abstract_inverted_index) : undefined,
      isRetracted: article.is_retracted
    }
  })
}

function revertAbstractFromInvertedIndex (abstract_inverted_index) {
  const abstract = []
  Object.keys(abstract_inverted_index).forEach(word => abstract_inverted_index[word].forEach(i => { abstract[i] = word }))
  return abstract.join(' ').replace('  ', ' ').trim()
}

/* Crossref API */

function crossrefWorks (expression, responseFunction, count) {
  // TODO Now that subselection of results is fixed, it could be leveraged to reduce API load (https://gitlab.com/crossref/issues/issues/511)
  let body = {
    filter: expression,
    // 'count' necessary beacause Crossref otherwise reverts to default of only 20 rows
    rows: count,
    offset: 0,
    mailto: 'local-citation-network@timwoelfle.de'
  }

  // Encode request body as URLencoded
  body = Object.keys(body).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(body[k])
  }).join('&')

  return fetch('https://api.crossref.org/works?' + body).then(response => {
    return response.json()
  }).then(data => {
    if (data.status === 'failed') {
      throw new Error(data.message && data.message[0] && data.message[0].message)
    }
    responseFunction(data)
  }).catch(error =>
    vm.errorMessage('Error while processing data through Crossref API: ' + error)
  )
}

function crossrefResponseToArticleArray (data, sourceReferences) {
  return data.message.items.map(function (article) {
    // filter is necessary because some references don't have DOIs in Crossref (https://stackoverflow.com/questions/28607451/removing-undefined-values-from-array)
    const references = (typeof article.reference === 'object') ? article.reference.map(x => (x.DOI) ? x.DOI.toUpperCase() : undefined) : []; const doi = article.DOI.toUpperCase()

    return {
      id: doi,
      // Crossref actually returns references in the original order (as opposed to MA & OC)
      numberInSourceReferences: (doi && sourceReferences.length) ? sourceReferences.indexOf(doi) + 1 : undefined,
      doi: doi,
      title: String(article.title), // most of the time title is an array with length=1, but I've also seen pure strings
      authors: (article.author && article.author.length) ? article.author.map(x => ({ LN: x.family || x.name, FN: x.given, affil: String(x.affiliation) || undefined })) : [{ LN: article.author || undefined }],
      year: article.issued['date-parts'] && article.issued['date-parts'][0] && article.issued['date-parts'][0][0],
      journal: String(article['container-title']),
      references: references || [], // Crossref "references" array contains null positions for references it doesn't have DOIs for, thus preserving the original number of references
      citationsCount: article['is-referenced-by-count'],
      abstract: article.abstract
    }
  })
}

/* OpenCitations API */

function openCitationsMetadata (expression, responseFunction) {
  // https://opencitations.net/index/api/v1#/metadata/{DOIs}
  return fetch('https://opencitations.net/index/api/v1/metadata/' + expression).then(response => {
    if (!response.ok) {
      throw new Error(response)
    }
    return response.json()
  }).then(data => {
    responseFunction(data)
  }).catch(error => {
    vm.errorMessage('Error while processing data through OpenCitations API: ' + error)
  })
}

function openCitationsResponseToArticleArray (data, sourceReferences) {
  return data.map(function (article) {
    const references = (article.reference) ? article.reference.split('; ').map(x => x.toUpperCase()) : []; const doi = article.doi.toUpperCase()

    return {
      id: doi,
      // OpenCitations doesn't seem to return references in original ordering
      // Nonetheless, when the input is a listOfDOIs (i.e. file / bookmarklet), the order can be recovered
      numberInSourceReferences: (doi && sourceReferences.length) ? sourceReferences.indexOf(doi) + 1 : undefined,
      doi: doi,
      title: String(article.title), // most of the time title is an array with length=1, but I've also seen pure strings
      authors: article.author.split('; ').map(x => ({ LN: x.split(', ')[0], FN: x.split(', ')[1] })),
      year: article.year,
      journal: String(article.source_title),
      references: references,
      citations: (article.citation) ? article.citation.split('; ').map(x => x.toUpperCase()) : [],
      citationsCount: Number(article.citation_count)
    }
  })
}

/* vis.js Reference graph */

// I've tried keeping citationNetwork in Vue's data, but it slowed things down a lot -- better keep it as global variable as network is not rendered through Vue anyway
let citationNetwork, authorNetwork

function initCitationNetwork (app) {
  // This line is necessary because of v-if="currentGraphIndex !== undefined" in the main columns div, which apparently is evaluated after watch:currentGraphIndex is called
  if (!document.getElementById('citationNetwork')) return setTimeout(function () { app.init() }, 1)

  // Create an array with nodes only for nodes with in- / out-degree >= 1 (no singletons)
  const articles = app.currentGraph.input.filter(article => article.year && (app.inDegree(article.id) || app.outDegree(article.id))).concat(app.incomingSuggestionsSliced).concat(app.outgoingSuggestionsSliced)
  const articlesIds = articles.map(article => article.id)

  // Create an array with edges
  const edges = articles.map(function (article) {
    return (!article.references) ? [] : article.references.map(function (ref) {
      if (articlesIds.includes(ref)) {
        return { from: article.id, to: ref }
      } else {
        return []
      }
    })
  }).flat(2)

  // Sort by rank of year
  const years = Array.from(new Set(articles.map(article => article.year).sort()))

  const nodes = articles.map(article => ({
    id: article.id,
    title: app.authorStringShort(article.authors) + '. ' + article.title + '. ' + article.journal + '. ' + article.year + '.',
    level: years.indexOf(article.year),
    group: article.year,
    size: arrSum([5, app.inDegree(article.id), app.outDegree(article.id)]) * 5,
    shape: (app.currentGraph.source.id === article.id) ? 'diamond' : (app.inputArticlesIds.includes(article.id) ? 'dot' : (app.incomingSuggestionsIds.includes(article.id) ? 'triangle' : 'triangleDown')),
    label: (article.authors[0] && article.authors[0].LN) + '\n' + article.year
  }))

  // Create network
  const options = {
    layout: {
      hierarchical: {
        direction: 'DU',
        levelSeparation: 400
      }
    },
    nodes: {
      font: {
        size: 150
      }
    },
    edges: {
      color: {
        color: 'rgba(200,200,200,0.3)',
        highlight: 'rgba(0,0,0,0.3)'
      },
      arrows: {
        to: {
          enabled: true,
          scaleFactor: 4
        }
      },
      width: 5
      // chosen: { edge: function(values, id, selected, hovering) { values.inheritsColor = "from" } },
    },
    interaction: {
      selectConnectedEdges: true
    },
    physics: {
      hierarchicalRepulsion: {
        nodeDistance: 600
      },
      stabilization: {
        iterations: 200
      }
    },
    configure: false
  }
  citationNetwork = new vis.Network(document.getElementById('citationNetwork'), { nodes: nodes, edges: edges }, options)
  citationNetwork.on('click', networkOnClick)
  citationNetwork.on('doubleClick', networkOnDoubleClick)
  citationNetwork.on('resize', function () { citationNetwork.fit() })

  function networkOnClick (params) {
    let selectedNode

    // Select corresponding row in table
    if (params.nodes.length > 0) {
      selectedNode = params.nodes[0]
      // Input article node was clicked (circle)
      if (app.inputArticlesIds.includes(selectedNode)) {
        app.showArticlesTab = 'inputArticles'
        app.selectedInputArticle = app.currentGraph.input[app.inputArticlesIds.indexOf(selectedNode)]
        // Suggested article node was clicked (triangle)
      } else if (app.incomingSuggestionsIds.includes(selectedNode)) {
        app.showArticlesTab = 'incomingSuggestions'
        app.selectedIncomingSuggestionsArticle = app.currentGraph.incomingSuggestions[app.incomingSuggestionsIds.indexOf(selectedNode)]
      } else {
        app.showArticlesTab = 'outgoingSuggestions'
        app.selectedOutgoingSuggestionsArticle = app.currentGraph.outgoingSuggestions[app.outgoingSuggestionsIds.indexOf(selectedNode)]
      }
    // Don't select edges
    } else {
      citationNetwork.setSelection({
        nodes: [app.selected.id],
        edges: []
      })
    }
  }

  function networkOnDoubleClick (params) {
    let selectedNode, article

    // Open article in new tab
    if (params.nodes.length > 0) {
      selectedNode = params.nodes[0]
      article = app.currentGraph.input[app.inputArticlesIds.indexOf(selectedNode)] || app.currentGraph.incomingSuggestions[app.incomingSuggestionsIds.indexOf(selectedNode)]
      window.open('https://doi.org/' + article.doi, '_blank')
    }
  }
}

function initAuthorNetwork (app, minPublications = undefined) {
  if (!document.getElementById('authorNetwork')) return false

  // Unfortunately, currently the new Set() requires each author name be unique
  // (I know this can cause trouble with non-unique author names actually shared by two people publishing in similar fields but I'm currently not taking this into account)
  let authorGroups = app.currentGraph.input.concat(app.incomingSuggestionsSliced).concat(app.outgoingSuggestionsSliced).map(article => article.authors ? Array.from(new Set(article.authors.map(x => x.FN + ' ' + x.LN))) : [])
  const authors = {}
  let authorsWithMinPubs = []
  const links = {}

  // Get authors from more than one publication
  authorGroups.flat().forEach(author => { authors[author] = (authors[author] || 0) + 1 })

  if (!minPublications) {
    minPublications = 2
    authorsWithMinPubs = Object.keys(authors).filter(author => authors[author] >= minPublications)
    while (authorsWithMinPubs.length > 50) {
      minPublications++
      authorsWithMinPubs = Object.keys(authors).filter(author => authors[author] >= minPublications)
    }
    app.minPublications = minPublications
  } else {
    authorsWithMinPubs = Object.keys(authors).filter(author => authors[author] >= minPublications)
  }

  authorGroups = authorGroups.map(group => group.filter(author => authorsWithMinPubs.includes(author)))

  authorGroups.forEach(group => group.forEach(indiv1 => group.forEach(indiv2 => {
    if (indiv1 === indiv2) return false

    // Is there already a link for this pair? If so, make it stronger
    if (links[indiv1] && links[indiv1][indiv2]) return links[indiv1][indiv2]++
    if (links[indiv2] && links[indiv2][indiv1]) return links[indiv2][indiv1]++

    // Create new link
    if (!links[indiv1]) links[indiv1] = {}
    links[indiv1][indiv2] = 1
  })))

  const edges = Object.keys(links).map(indiv1 => Object.keys(links[indiv1]).map(indiv2 => {
    return { from: indiv1, to: indiv2, value: links[indiv1][indiv2], title: indiv1 + ' & ' + indiv2 + ' (' + links[indiv1][indiv2] / 2 + ' collaboration(s) among source, input & suggested articles)' }
  })).flat(2)

  const nodes = authorsWithMinPubs.map(author => {
    return {
      id: author,
      title: author + ((app.authorString(app.currentGraph.source.authors).includes(author)) ? ' ((co)author of source article) (' : ' (') + authors[author] + ' publication(s) among input & suggested articles)',
      group: authorGroups.map(group => group.includes(author)).indexOf(true),
      label: author.substr(author.lastIndexOf(' ') + 1),
      size: authors[author] * 3,
      shape: (app.authorString(app.currentGraph.source.authors).includes(author)) ? 'diamond' : 'dot'
    }
  })

  // create a network
  const options = {
    nodes: {
      font: {
        size: 20
      }

    },
    edges: {
      color: {
        color: 'rgba(200,200,200,0.3)'
      },
      smooth: false
    },
    physics: {
      maxVelocity: 20
    },
    interaction: {
      dragNodes: true,
      multiselect: true,
      hideEdgesOnDrag: true,
      hideEdgesOnZoom: true
    },
    configure: false
  }
  authorNetwork = new vis.Network(document.getElementById('authorNetwork'), { nodes: nodes, edges: edges }, options)
  authorNetwork.on('click', networkOnClick)
  authorNetwork.on('resize', function () { authorNetwork.fit() })

  function networkOnClick (params) {
    app.filterColumn = 'authors'

    // If no node is clicked...
    if (!params.nodes.length) {
      // Maybe an edge?
      if (params.edges.length) {
        const edge = authorNetwork.body.data.edges.get(params.edges[0])
        app.highlightNodes([edge.from, edge.to])
        app.filterString = '(?=.*' + edge.from + ')(?=.*' + edge.to + ')'
        return app.filterString
        // Otherwise reset filterString
      } else {
        app.filterString = undefined
        return false
      }
    }

    // If just one node is selected perform simple filter for that author
    if (params.nodes.length === 1) {
      app.filterString = params.nodes[0]
      // If more than one node are selected, perform "boolean and" in regular expression through lookaheads, which means order isn't important (see https://www.ocpsoft.org/tutorials/regular-expressions/and-in-regex/)
    } else {
      app.filterString = '(?=.*' + params.nodes.join(')(?=.*') + ')'
    }

    app.highlightNodes(params.nodes)
  }
}

/* App logic */

Vue.use(Buefy)

const vm = new Vue({
  el: '#app',
  data: {
    // Settings
    API: 'OpenAlex', // Use 'OpenAlex' as default, other options: 'Semantic Scholar, 'Crossref', 'OpenCitations' ('Microsoft Academic' was discontinued 01/2022)
    maxTabs: 5,
    autosaveResults: false,

    // Data
    graphs: [],
    newSource: undefined,
    file: undefined,
    listOfDOIs: [],
    listName: undefined,

    // UI
    fullscreenNetwork: false,
    filterColumn: 'titleAbstract',
    filterString: undefined,
    selectedInputArticle: undefined,
    selectedIncomingSuggestionsArticle: undefined,
    selectedOutgoingSuggestionsArticle: undefined,
    currentGraphIndex: undefined,
    maxIncomingSuggestions: undefined,
    maxOutgoingSuggestions: undefined,
    showArticlesTab: 'inputArticles',
    showAuthorNetwork: 0,
    minPublications: 2,
    isLoading: false,
    showFAQ: false,
    indexFAQ: 'about',
    editListOfDOIs: false
  },
  computed: {
    editedListOfDOIs: {
      get: function () { return this.listOfDOIs.join('\n') },
      set: function (x) { this.listOfDOIs = x.split('\n') }
    },
    currentGraph: function () {
      if (this.currentGraphIndex === undefined) return {}
      return this.graphs[this.currentGraphIndex]
    },
    inputArticlesFiltered: function (articles) {
      return this.filterArticles(this.currentGraph.input)
    },
    inputArticlesIds: function () {
      return this.currentGraph.input.map(article => article.id)
    },
    incomingSuggestionsSliced: function () {
      return this.currentGraph.incomingSuggestions.slice(0, this.maxIncomingSuggestions)
    },
    outgoingSuggestionsSliced: function () {
      return this.currentGraph.outgoingSuggestions.slice(0, this.maxOutgoingSuggestions)
    },
    incomingSuggestionsIds: function () {
      return this.incomingSuggestionsSliced.map(article => article.id)
    },
    outgoingSuggestionsIds: function () {
      return this.outgoingSuggestionsSliced.map(article => article.id)
    },
    incomingSuggestionsFiltered: function () {
      return this.filterArticles(this.incomingSuggestionsSliced)
    },
    outgoingSuggestionsFiltered: function () {
      return this.filterArticles(this.outgoingSuggestionsSliced)
    },
    selected: function () {
      switch (this.showArticlesTab) {
        case 'inputArticles': return this.selectedInputArticle
        case 'incomingSuggestions': return this.selectedIncomingSuggestionsArticle
        case 'outgoingSuggestions': return this.selectedOutgoingSuggestionsArticle
      }
    },

    // The following are for the estimation of the completeness of the data
    inputArticlesWithoutSource: function () {
      return this.currentGraph.input.filter(article => article.id != this.currentGraph.source.id)
    },
    sourceReferencesCompletenessFraction: function () {
      return this.inputArticlesWithoutSource.length / this.currentGraph.source.references.length
    },
    inputHasReferences: function () {
      return arrSum(this.inputArticlesWithoutSource.map(x => x.references.length !== 0))
    },
    inputReferencesCompletenessFraction: function () {
      return arrAvg(this.inputArticlesWithoutSource.filter(x => x.references.length !== 0).map(x => x.references.filter(Boolean).length / x.references.length))
    },
    completenessLabel: function () {
      let label = ''
      // Show number of "original references" only for Semantic Scholar / Crossref for source-based-graphs and for all listOfDOIs (i.e. file / bookmarklet) graphs, for which they can be estimated
      if (['Semantic Scholar', 'Crossref'].includes(this.currentGraph.API) || !this.currentGraph.source.id) {
        if (this.currentGraph.source.id) {
          label += 'Source and '
        }
        label += `${this.inputArticlesWithoutSource.length} of originally ${this.currentGraph.source.references.length} references were found in ${this.currentGraph.API} (${Math.round(this.sourceReferencesCompletenessFraction * 100)}%), ${this.inputHasReferences} of which have reference-lists themselves (${Math.round(this.inputHasReferences / this.inputArticlesWithoutSource.length * 100)}%).`
      } else {
        label = `${this.inputHasReferences} of ${this.inputArticlesWithoutSource.length} input articles ${this.currentGraph.source.id ? '(excluding source) ' : ''}have reference-lists themselves in ${this.currentGraph.API} (${Math.round(this.inputHasReferences / this.inputArticlesWithoutSource.length * 100)}%).`
      }

      if (['Semantic Scholar', 'Crossref'].includes(this.currentGraph.API)) label += ` Their respective average reference completeness is ${Math.round(this.inputReferencesCompletenessFraction * 100)}%.`
      return label
    },
    completenessPercent: function () {
      return Math.round(this.sourceReferencesCompletenessFraction * this.inputHasReferences / this.inputArticlesWithoutSource.length * this.inputReferencesCompletenessFraction * 100)
    }
  },
  watch: {
    // Initialize graph when new tab is opened / tab is changed
    currentGraphIndex: function () {
      // Reset filterString when tab is changed
      this.filterString = undefined

      // Don't know how to prevent this from firing (and thus causing a reinit) when closing a tab (only noticeable by a short flicker of the network, thus not a real issue)
      if (this.graphs.length) {
        this.init()
      }
    },
    // User provided a new DOI or other id for source article
    newSource: function () {
      if (!this.newSource || !this.newSource.trim()) return false

      let id = this.newSource.trim()

      // Crossref only allows DOIs as ids
      if (this.API === 'Crossref') {
        // Ignore trailing string (e.g. 'DOI:' or 'https://doi.org/')
        if (id.match(/10\.\d{4,9}\/\S+/)) id = id.match(/10\.\d{4,9}\/\S+/)[0]
        else return this.errorMessage(id + ' is not a valid DOI, which must be in the form: 10.prefix/suffix where prefix is 4 or more digits and suffix is a string.')
      }

      // Set new source
      this.callAPI([id], data => {
        this.setNewSource(this.responseToArray(data)[0])
      }, 1, true) // count=1, getCitations=true
    },
    // User provided a file which is searched for DOIs
    file: function () {
      if (!this.file || !this.file.name) return false
      this.isLoading = true
      this.file.text().then(text => {
        this.isLoading = false
        // Using the set [-_;()/:A-Z0-9] twice (fullstop . and semicolon ; only in first set) makes sure that the trailing character is not a fullstop or semicolon
        const DOIs = Array.from(new Set(text.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+[-_()/:A-Z0-9]+/gi))).map(x => x.toUpperCase())
        if (!DOIs.length) throw new Error('No DOIs found in file.')
        this.listOfDOIs = DOIs
        this.listName = this.file.name
        this.editListOfDOIs = true
      }).catch(e => {
        this.isLoading = false
        this.errorMessage('Error with file handling: ' + e)
        // Reset input variables so that watchers fire again even if same input is given
        this.file = undefined
      })
    },
    // A different node (reference) in the graph has been selected
    selected: function () {
      if (!this.selected) return false

      // Highlight the right network node
      this.highlightNodes()

      // Scroll to right row
      if (document.getElementById(this.selected.id)) document.getElementById(this.selected.id).scrollIntoView({ behavior: 'smooth', block: 'center' })
    },
    maxIncomingSuggestions: function () {
      // Prevent too many re-inits
      if (this.graphs.length && document.getElementById('citationNetwork')) {
        initCitationNetwork(this)
        initAuthorNetwork(this)
        this.highlightNodes()
      }
    },
    maxOutgoingSuggestions: function () {
      // Prevent too many re-inits
      if (this.graphs.length && document.getElementById('citationNetwork')) {
        initCitationNetwork(this)
        initAuthorNetwork(this)
        this.highlightNodes()
      }
    },
    showAuthorNetwork: function () {
      this.highlightNodes()
    },
    minPublications: function () {
      initAuthorNetwork(this, this.minPublications)
      this.highlightNodes()
    }
  },
  methods: {
    setNewSource: function (source, label = undefined, title = undefined) {
      // Reset newSource (otherwise it cannot be called twice in a row with different APIs)
      this.newSource = undefined

      // Some papers can be found in the APIs but don't have references themselves in there
      if (!source) return this.errorMessage(`DOI ${this.newSource} not found in ${this.API} API, try other API.`)
      if (!source.references.length) return this.errorMessage(`No references found in ${this.API} API for paper: ${this.newSource}`)

      this.isLoading = true

      this.$buefy.toast.open({
        message: 'New query sent to ' + this.API + '.<br>This may take a while, depending on the number of references and API workload.',
        duration: 6000,
        queue: false
      })

      // Get Input articles
      // filter(Boolean) is necessary because references array can contain empty items in order to preserve original order of DOIs from crossref
      this.callAPI(source.references.filter(Boolean), data => {
        source.isSource = true
        let referencedBy = {}
        let citing = {}
        // Only send sourceReferences to responseToArray function when original numbering can be recovered (either for Crossref or listOfDOIs (i.e. file / bookmarklet))
        let inputArticles = this.responseToArray(data, (this.API === 'Crossref' || !source.id) ? source.references : false)
        // Don't put source in inputArticles (and thus network) when a list was loaded

        if (source.id) inputArticles = inputArticles.concat(source)
        const inputArticlesIds = inputArticles.map(article => article.id)

        function addToCiting (outId, inId) {
          if (inputArticlesIds.includes(inId)) {
            if (!citing[outId]) citing[outId] = []
            if (!citing[outId].includes(inId)) citing[outId].push(inId)
          }
        }

        inputArticles.forEach(article => {
          article.references.filter(Boolean).forEach(refId => {
            if (!referencedBy[refId]) referencedBy[refId] = []
            // Avoid duplicate counting of references for in-degree (e.g. https://api.crossref.org/works/10.7717/PEERJ.3544 has 5 references to DOI 10.1080/00031305.2016.1154108)
            if (!referencedBy[refId].includes(article.id)) referencedBy[refId].push(article.id)

            addToCiting(article.id, refId)
          })
          // Only Semantic Scholar and OpenCitations have incoming citations
          if (['Semantic Scholar', 'OpenCitations'].includes(this.API)) {
            article.citations.filter(Boolean).forEach(citId => {
              addToCiting(citId, article.id)
            })
            // Remove citations property to save space (otherwise localStorage quota exceeds sooner) because the information is now stored in "citing" variable
            delete inputArticles[inputArticles.indexOf(article)].citations
          }
        })

        /* Find incoming suggestions (high in-degree = top outgoing references) */
        // sort articles by number of local citations (inDegree) and pick top ones
        // https://medium.com/@alleto.saburido/set-theory-for-arrays-in-es6-eb2f20a61848
        const incomingSuggestionsIds = Object.keys(referencedBy)
        // Only suggest articles that have at least two local citations and that aren't already among input articles
        // Careful with comparing DOIs!!! They have to be all upper case
          .filter(x => referencedBy[x].length > 1 && !inputArticlesIds.includes(x))
          .sort((a, b) => referencedBy[b].length - referencedBy[a].length).slice(0, 20)

        let ids = inputArticlesIds.concat(incomingSuggestionsIds)

        if (incomingSuggestionsIds.length) {
          this.callAPI(incomingSuggestionsIds, data => {
            const incomingSuggestions = this.responseToArray(data)
            // Careful: Array/object item setting can't be picked up by Vue (https://vuejs.org/v2/guide/list.html#Caveats)
            this.$set(this.graphs[this.graphs.length - 1], 'incomingSuggestions', incomingSuggestions)

            // OpenAlex and Crossref do not have incoming citation data (in case of OpenAlex this is not implemented here yet), thus this has to be completed so that incoming suggestions have correct out-degrees, which are based on 'citing'
            if (['OpenAlex', 'Crossref'].includes(this.API)) {
              incomingSuggestions.forEach(article => {
                article.references.filter(Boolean).forEach(refId => {
                  addToCiting(article.id, refId)
                })
              })
              this.$set(this.graphs[this.graphs.length - 1], 'citing', citing)
            }

            this.init()
            this.saveState()
          }, incomingSuggestionsIds.length, false) // count=incomingSuggestionsIds.length, getCitations=false
        }

        /* Find outgoing suggestions (high out-degree = top incoming citations) */
        // Only works with Semantic Scholar and OpenCitations for now (TODO OpenAlex could support this feature as well with some more work)
        if (['Semantic Scholar', 'OpenCitations'].includes(this.API)) {
          const outgoingSuggestionsIds = Object.keys(citing)
            // If - in theoretical cases, I haven't seen one yet - a top incoming citation is already a top reference, don't include it here again
            .filter(x => citing[x].length > 1 && !inputArticlesIds.includes(x) && !incomingSuggestionsIds.includes(x))
            .sort((a, b) => citing[b].length - citing[a].length).slice(0, 20)

          ids = ids.concat(outgoingSuggestionsIds)

          if (outgoingSuggestionsIds.length) {
            this.callAPI(outgoingSuggestionsIds, data => {
              // Careful: Array/object item setting can't be picked up by Vue (https://vuejs.org/v2/guide/list.html#Caveats)
              this.$set(this.graphs[this.graphs.length - 1], 'outgoingSuggestions', this.responseToArray(data))
              this.init()
              this.saveState()
            }, outgoingSuggestionsIds.length, false) // count=outgoingSuggestionsIds.length, getCitations=false
          }
        }

        // Reduce size of referenced and citing objects by only keeping entries for input articles and suggestions
        referencedBy = ids.reduce((newObject, id) => { newObject[id] = referencedBy[id]; return newObject }, {})
        citing = ids.reduce((newObject, id) => { newObject[id] = citing[id]; return newObject }, {})

        // Add new tab
        this.graphs.push({
          source: source,
          input: inputArticles,
          incomingSuggestions: [],
          outgoingSuggestions: [],
          referenced: referencedBy,
          citing: citing,
          tabLabel: (label || (source.authors[0] && source.authors[0].LN) + ' ' + source.year) + ' (' + this.abbreviateAPI(this.API) + ')',
          tabTitle: title || source.title,
          API: this.API,
          timestamp: Date.now()
        })

        // Don't keep more articles in tab-bar than maxTabs
        if (this.graphs.length > this.maxTabs) this.graphs = this.graphs.slice(1)

        // Let user explore input articles while suggestions are still loading
        this.showArticlesTab = 'inputArticles'
        this.currentGraphIndex = this.graphs.length - 1
        this.isLoading = false

        this.saveState()
      }, source.references.length, true) // count=source.references.length, getCitations=true
    },
    clickOpenReferences: function (article) {
      const id = article.id
      const graphSourceIds = this.graphs.map(graph => graph.source.id)

      // If reference is already open in a different tab: change tabs only
      if (graphSourceIds.includes(id)) {
        this.currentGraphIndex = graphSourceIds.indexOf(id)
      // Load new source through API when source used different API than currently active
      } else {
        this.newSource = String(article.doi)
      }
    },
    clickButtonAdd: function () {
      this.$buefy.dialog.prompt({
        message: (this.API === 'OpenAlex')
          ? 'Enter <a href="https://docs.openalex.org/about-the-data/work#ids" target="_blank">DOI / PMID / other ID</a> of new source article'
          : ((this.API === 'Semantic Scholar')
            ? 'Enter <a href="https://api.semanticscholar.org/graph/v1#operation/get_graph_get_paper_references" target="_blank">DOI / PMID / ARXIV / other ID</a> of new source article'
            : 'Enter DOI of new source article'),
        inputAttrs: {
          placeholder: 'e.g. doi:10.1126/SCIENCE.AAC4716',
          maxlength: 50
        },
        onConfirm: value => { this.newSource = value }
      })
    },
    clickCloseTab: function (index) {
      // Close tab
      this.graphs.splice(index, 1)
      // If a tab is closed before the selected one or the last tab is selected and closed: update currentGraphIndex
      if (this.currentGraphIndex > index || this.currentGraphIndex > this.graphs.length - 1) {
        this.currentGraphIndex--
        if (this.currentGraphIndex === -1) this.currentGraphIndex = undefined
      }
      this.saveState()
    },
    clickCloseAllTabs: function () {
      this.$buefy.dialog.confirm({
        message: 'Do you want to close all reference tabs?',
        type: 'is-danger',
        confirmText: 'Close All',
        onConfirm: () => {
          this.currentGraphIndex = undefined
          this.graphs = []
          this.saveState()
        }
      })
    },
    highlightNodes: function (selectedNodes = undefined) {
      const network = (this.showAuthorNetwork) ? authorNetwork : citationNetwork

      if (!network) return false

      // When nodes are clicked in authorNetwork, the selectedNodes are supplied by argument, otherwise they depend on table selection and are figured out here
      if (!selectedNodes) {
      // Highlight selected node if one is selected
        if (this.showAuthorNetwork) {
          selectedNodes = []
          this.selected.authors.map(x => x.FN + ' ' + x.LN).forEach(author => {
            if (network.body.data.nodes.getIds().includes(author)) {
              selectedNodes.push(author)
            }
          })
        } else {
          if (network.body.data.nodes.getIds().includes(this.selected.id)) {
            selectedNodes = [this.selected.id]
          } else {
            selectedNodes = []
          }
        }
      }

      network.selectNodes(selectedNodes)
      const connectedNodes = network.getConnectedNodes(selectedNodes)

      // Code loosely adapted from: https://github.com/visjs/vis-network/blob/master/examples/network/exampleApplications/neighbourhoodHighlight.html
      const updatedNodes = network.body.data.nodes.get().map(function (node) {
        node.color = (selectedNodes.includes(node.id) || connectedNodes.includes(node.id)) ? undefined : 'rgba(200,200,200,0.3)'
        if (selectedNodes.includes(node.id)) {
          if (node.hiddenLabel !== undefined) {
            node.label = node.hiddenLabel
            node.hiddenLabel = undefined
          }
        } else {
          if (node.hiddenLabel === undefined) {
            node.hiddenLabel = node.label
            node.label = undefined
          }
        }
        return node
      })

      network.body.data.nodes.update(updatedNodes)
    },
    init: function () {
      // Sort tables
      this.currentGraph.input.sort(this.sortInDegree)
      this.currentGraph.incomingSuggestions.sort(this.sortInDegree)
      this.currentGraph.outgoingSuggestions.sort(this.sortOutDegree)

      // Select top article for tables
      this.selectedInputArticle = this.currentGraph.input[0]
      this.selectedIncomingSuggestionsArticle = this.currentGraph.incomingSuggestions[0]
      this.selectedOutgoingSuggestionsArticle = this.currentGraph.outgoingSuggestions[0]

      // Reset maximum number of suggestions
      this.maxIncomingSuggestions = Math.min(10, this.currentGraph.incomingSuggestions.length)
      this.maxOutgoingSuggestions = Math.min(10, this.currentGraph.outgoingSuggestions.length)

      // Networks are handled by vis.js outside of Vue through these two global init function
      // Initializing both networks now incurs higher CPU usage now but then tab changes are quicker compared to init at watch:showAuthorNetwork (especially when going back and forth)
      initAuthorNetwork(this)
      initCitationNetwork(this)
      // Sometimes this call to highlightNodes() leads to two calls in short frequency (because watch:selected will often be called right afterwards) but this call is still necessary (apparently mostly when loading new graphs)
      this.highlightNodes()
    },
    inDegree: function (id) {
      return (this.currentGraph.referenced[id]) ? this.currentGraph.referenced[id].length : 0
    },
    outDegree: function (id) {
      return (this.currentGraph.citing[id]) ? this.currentGraph.citing[id].length : 0
    },
    // compareFunction for array.sort(), in this case descending by default (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/sort)
    sortInDegree: function (a, b) {
      a = this.inDegree(a.id)
      b = this.inDegree(b.id)
      return b - a
    },
    sortOutDegree: function (a, b) {
      a = this.outDegree(a.id)
      b = this.outDegree(b.id)
      return b - a
    },
    // Wrapper for Buefy tables with third argument "ascending"
    sortInDegreeWrapper: function (a, b, ascending) {
      return (ascending) ? this.sortInDegree(b, a) : this.sortInDegree(a, b)
    },
    sortOutDegreeWrapper: function (a, b, ascending) {
      return (ascending) ? this.sortOutDegree(b, a) : this.sortOutDegree(a, b)
    },
    callAPI: function (ids, response, count, getCitations) {
      if (this.API === 'OpenAlex') {
        ids = ids.map(id => {
          if (id.match(/openalex:|doi:|mag:|pmid:|pmcid:/i)) return id
          else if (id.includes('/')) return 'doi:' + id
          else return 'openalex:' + id
        })
        return openAlexWrapper(ids.join(','), response)
      } else if (this.API === 'Semantic Scholar') {
        return semanticScholarWrapper(ids.join(','), response, getCitations)
      } else if (this.API === 'Crossref') {
        // In Crossref the API also returns references as DOIs
        return crossrefWorks('doi:' + ids.join(',doi:'), response, count)
      } else {
        // In OpenCitations API also returns references as DOIs
        return openCitationsMetadata(ids.join('__'), response)
      }
    },
    responseToArray: function (data, sourceReferences = false) {
      if (this.API === 'Semantic Scholar') {
        return semanticScholarResponseToArticleArray(data, sourceReferences)
      } else if (this.API === 'OpenAlex') {
        return openAlexResponseToArticleArray(data, sourceReferences)
      } else if (this.API === 'Crossref') {
        return crossrefResponseToArticleArray(data, sourceReferences)
      } else {
        return openCitationsResponseToArticleArray(data, sourceReferences)
      }
    },
    errorMessage: function (message) {
      // if (cancelLoading) this.isLoading = false
      this.$buefy.toast.open({
        message: String(message),
        type: 'is-danger',
        duration: 6000,
        queue: false,
        pauseOnHover: true
      })
    },
    saveState: function () {
      if (this.autosaveResults) {
        localStorage.graphs = JSON.stringify(this.graphs)
        localStorage.autosaveResults = true
        localStorage.API = this.API
      } else {
        localStorage.clear()
      }
    },
    filterArticles: function (articles) {
      const re = new RegExp(this.filterString, 'gi')
      switch (this.filterColumn) {
        case 'titleAbstract':
          return articles.filter(article => String(article.numberInSourceReferences).match(new RegExp(this.filterString, 'y')) || article.title.match(re) || (article.abstract && article.abstract.match(re)))
        case 'authors':
          return articles.filter(article => article.authors.map(author => (author.FN + ' ' + author.LN)).join(', ').match(re))
        case 'year':
          return articles.filter(article => String(article.year).match(re))
        case 'journal':
          return articles.filter(article => String(article.journal).match(re))
        default:
          return articles
      }
    },
    authorString: function (authors) {
      return (authors && authors.length) ? authors.map(x => ((x.FN) ? (x.FN) + ' ' : '') + x.LN).join(', ') : ''
    },
    authorStringShort: function (authors) {
      return (authors && authors.length > 5) ? this.authorString(authors.slice(0, 5).concat({ LN: '(' + (authors.length - 5) + ' more)' })) : this.authorString(authors)
    },
    // Toggle autosave option
    clickToggleAutosave: function () {
      this.autosaveResults = !this.autosaveResults
      this.saveState()
      this.$buefy.toast.open({
        message: (this.autosaveResults) ? 'Local autosave on' : 'Local autosave off',
        type: (this.autosaveResults) ? 'is-success' : 'is-danger',
        queue: false
      })
    },
    clickToggleAPI: function () {
      if (['OpenCitations', 'Crossref'].includes(this.API)) {
        this.API = 'OpenAlex'
        this.$buefy.toast.open({
          message: 'Using OpenAlex (OA)',
          queue: false
        })
      } else if (this.API === 'OpenAlex') {
        this.API = 'Semantic Scholar'
        this.$buefy.toast.open({
          message: 'Using Semantic Scholar (S2)',
          queue: false
        })
      } else {
        this.API = 'Crossref'
        this.$buefy.toast.open({
          message: 'Using Crossref (CR)',
          queue: false
        })
      }
    },
    loadExamples: function () {
      this.isLoading = true
      const scriptTag = document.createElement('script')
      scriptTag.setAttribute('src', 'examples.js')
      document.getElementsByTagName('head')[0].appendChild(scriptTag)
    },
    toggleArticle: function () {
      // Make sure article can even be toggled (compare with :has-detailed-visible in b-table in index.html)
      if (this.selected.abstract) {
        this.$refs[this.showArticlesTab + 'Table'].toggleDetails(this.selected)
        // if (document.getElementById(this.selected.id)) document.getElementById(this.selected.id).scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    },
    formatAbstract: function (abstract) {
      return abstract.replace(/(Importance|Background|Aims?|Goals?|Objectives?|Purpose|Main Outcomes? and Measures?|Methods?|Results?|Discussions?|Conclusions?)/gi, '<em>$1</em>')
    },
    importList: function () {
      this.editListOfDOIs = false
      this.setNewSource({ references: this.listOfDOIs, citations: [] }, this.listName, this.listName)
    },
    clickToggleFullscreen: function () {
      this.fullscreenNetwork = !this.fullscreenNetwork
      citationNetwork.setOptions({ layout: { hierarchical: { direction: this.fullscreenNetwork ? 'LR' : 'DU' } } })
    },
    abbreviateAPI: function (API) {
      switch (API) {
        case 'OpenAlex': return 'OA'
        case 'Semantic Scholar': return 'S2'
        case 'Crossref': return 'CR'
        case 'OpenCitations': return 'OC'
      }
    }
  },
  created: function () {
    const urlParams = new URLSearchParams(window.location.search)

    try {
      if (localStorage.graphs) this.graphs = JSON.parse(localStorage.graphs)
      if (localStorage.autosaveResults) this.autosaveResults = localStorage.autosaveResults
      if (localStorage.API && ['OpenAlex', 'Semantic Scholar', 'Crossref', 'OpenCitations'].includes(localStorage.API)) this.API = localStorage.API
    } catch (e) {
      localStorage.clear()
      console.log("Couldn't load cached networks")
    }

    // Set API according to link
    if (urlParams.has('API') && ['OpenAlex', 'Semantic Scholar', 'Crossref', 'OpenCitations'].includes(urlParams.get('API'))) {
      this.API = urlParams.get('API')
    }

    // Open source from link
    if (urlParams.has('source')) {
      const id = urlParams.get('source'); const graphSourceIds = this.graphs.map(graph => graph.source.id)

      // Only if reference is not already open in a different tab with same API (setting to correct tab via this.currentGraphIndex = X doesn't work because it is initialized to default afterwards)
      if (!(graphSourceIds.includes(id) && this.graphs[graphSourceIds.indexOf(id)].API === this.API)) {
        this.newSource = id
      }
    // Open list of DOIs from link if tab is not already stored in localStorage
    } else if (urlParams.has('listOfDOIs')) {
      const name = urlParams.has('name') ? urlParams.get('name') : 'Custom'
      // Safety measure to allow max. 500 DOIs (not sure if any API actually allows this)
      const DOIs = urlParams.get('listOfDOIs').split(',')
        .slice(0, 500)
        .map(id => (id.match(/10\.\d{4,9}\/\S+/)) ? id.match(/10\.\d{4,9}\/\S+/)[0].toUpperCase() : id)

      this.listOfDOIs = DOIs
      this.listName = name
      this.editListOfDOIs = true
    // Linked to examples? Only load when no other graphs are opened
    } else if (this.graphs.length === 0 && urlParams.has('examples')) {
      this.loadExamples()
    }

    // Linked to FAQ?
    if (window.location.hash.length) {
      this.showFAQ = true
      this.indexFAQ = window.location.hash.substr(1)
    }

    if (this.graphs.length) {
      this.currentGraphIndex = 0
    }
  }
})
