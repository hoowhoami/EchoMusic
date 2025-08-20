//
//  SearchTextView.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/20.
//

import SwiftUI

// 搜索文本视图组件：包含完整的搜索功能
struct SearchTextView: View {
    @State private var searchText = ""
    @State private var isSearching = false
    @State private var showSearchResults = false
    @State private var searchResults: SearchResult?
    @State private var searchSuggestions: SearchSuggestResult?
    @State private var hotSearchItems: [HotSearchItem] = []
    @State private var defaultKeyword: String = ""
    @State private var isLoading = false
    @State private var errorMessage = ""
    
    @FocusState private var isTextFieldFocused: Bool
    @State private var showPopover = false
    @State private var debouncedSearchText = ""
    @State private var showingSearchResultsView = false
    @State private var searchDebounceTimer: Timer?
    
    private let searchService = SearchService.shared
    private let playerService = PlayerService.shared
    
    var body: some View {
        HStack(spacing: 0) {
            Spacer()
            
            // 搜索框（按钮包裹）
            Button(action: {
                print("🎯 搜索框按钮被点击")
                // 切换弹出框显示状态
                if showPopover {
                    showPopover = false
                } else {
                    // 显示弹出框，条件是有热搜数据或有搜索文本
                    let shouldShow = !searchText.isEmpty || !hotSearchItems.isEmpty
                    print("🎯 计算是否应该显示弹出框: \(shouldShow)")
                    print("🎯 条件分析: searchTextEmpty=\(searchText.isEmpty), hotSearchCount=\(hotSearchItems.count)")
                    showPopover = shouldShow
                }
                // 延迟给 TextField 焦点，确保按钮处理完成后再设置焦点
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    isTextFieldFocused = true
                }
            }) {
                HStack(alignment: .center, spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .foregroundColor(.secondary)
                        .font(.system(size: 13))
                        .frame(width: 13, height: 13)
                    
                    TextField(defaultKeyword.isEmpty ? "搜索音乐、歌手、歌单、分享码" : defaultKeyword, text: $searchText)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12))
                        .focused($isTextFieldFocused)
                        .onSubmit {
                            performSearch()
                        }
                        .onChange(of: searchText) { newValue in
                            handleTextChange(newValue)
                        }
                        .allowsHitTesting(true)
                    
                    if !searchText.isEmpty {
                        Button(action: {
                            clearSearch()
                        }) {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundColor(.secondary)
                                .font(.system(size: 11))
                        }
                        .buttonStyle(PlainButtonStyle())
                    }
                }
                .frame(width: 300, height: 28)
                .padding(.horizontal, 14)
                .background(Color.gray.opacity(0.1))
                .cornerRadius(10)
                .contentShape(Rectangle())
            }
            .buttonStyle(PlainButtonStyle())
            .allowsHitTesting(true)
            .popover(isPresented: $showPopover, arrowEdge: .bottom) {
                popoverContent
            }
            
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .background(Color.clear)
        .sheet(isPresented: $showingSearchResultsView) {
            if !searchText.isEmpty {
                SearchResultsView(keyword: searchText)
                    .frame(width: 800, height: 600)
            }
        }
        .onAppear {
            print("🔍 SearchTextView 出现")
            print("🔍 初始状态: showPopover=\(showPopover), isTextFieldFocused=\(isTextFieldFocused)")
            loadInitialData()
        }
        .onChange(of: showPopover) { newValue in
            print("🎯 showPopover 状态变化: \(newValue)")
        }
        .onChange(of: debouncedSearchText) { newValue in
            if !newValue.isEmpty {
                loadSearchSuggestions(keyword: newValue)
                // 如果正在显示弹出框，确保显示搜索建议
                if showPopover {
                    // 弹出框会自动更新内容
                }
            } else {
                searchSuggestions = nil
                // 如果弹出框正在显示且有热搜数据，继续显示热搜
                if showPopover && !hotSearchItems.isEmpty {
                    // 弹出框会自动切换到热搜内容
                }
            }
        }
        .onChange(of: hotSearchItems) { newItems in
            print("🔥 热搜数据更新，数量: \(newItems.count)")
            // 热搜数据更新后，如果弹出框正在显示，会自动更新内容
        }
    }
    
    // MARK: - 弹出框内容
    private var popoverContent: some View {
        VStack(spacing: 0) {
            if !searchText.isEmpty {
                // 显示搜索建议
                if isLoading {
                    loadingView
                } else if let suggestions = searchSuggestions?.data, !suggestions.isEmpty {
                    searchSuggestionsContent
                } else {
                    emptySuggestionsView
                }
            } else {
                // 显示热搜
                if isLoading {
                    loadingView
                } else if !hotSearchItems.isEmpty {
                    hotSearchContent
                } else {
                    emptyHotSearchView
                }
            }
        }
        .frame(width: 360, height: 300)
        .padding(8)
        .onTapGesture {
            // 阻止弹出框内部点击导致失去焦点
        }
        .onAppear {
            print("📋 弹出框内容显示了")
            print("📋 当前状态: searchText='\(searchText)', hotSearchCount=\(hotSearchItems.count), isLoading=\(isLoading)")
        }
        .onDisappear {
            print("📋 弹出框内容隐藏了")
        }
    }
    
    // MARK: - 加载视图
    private var loadingView: some View {
        HStack {
            Spacer()
            ProgressView()
                .scaleEffect(0.8)
            Spacer()
        }
        .padding()
    }
    
    // MARK: - 空状态视图
    private var emptySuggestionsView: some View {
        VStack {
            Spacer()
            HStack {
                Spacer()
                Text("暂无搜索建议")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                Spacer()
            }
            Spacer()
        }
        .frame(height: 60)
    }
    
    private var emptyHotSearchView: some View {
        VStack {
            Spacer()
            HStack {
                Spacer()
                Text("加载热搜中...")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                Spacer()
            }
            Spacer()
        }
        .frame(height: 60)
    }
    
    // MARK: - 搜索建议内容
    private var searchSuggestionsContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let sections = searchSuggestions?.data {
                ForEach(sections, id: \.LableName) { section in
                    if let items = section.RecordDatas, !items.isEmpty {
                        suggestSection(section: section, items: items)
                    }
                }
            }
            
            if isLoading {
                HStack {
                    Spacer()
                    ProgressView()
                        .scaleEffect(0.8)
                    Spacer()
                }
                .padding()
            }
        }
    }
    
    // MARK: - 热搜内容
    private var hotSearchContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("热搜榜")
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(.primary)
                .padding(.horizontal, 12)
                .padding(.top, 8)
            
            ForEach(0..<min(5, hotSearchItems.count), id: \.self) { index in
                let item = hotSearchItems[index]
                hotSearchItemView(index: index, item: item)
            }
        }
    }
    
    // MARK: - 热搜项视图
    private func hotSearchItemView(index: Int, item: HotSearchItem) -> some View {
        Button(action: {
            print("🔥 点击热搜项: \(item.keyword ?? "")")
            handleHotSearchSelection(item)
        }) {
            HStack(spacing: 8) {
                Text("\(index + 1)")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(index < 3 ? .red : .secondary)
                    .frame(width: 16)
                
                Text(item.keyword ?? "")
                    .font(.system(size: 11))
                    .foregroundColor(.primary)
                    .lineLimit(1)
                
                Spacer()
                
                if let icon = item.icon, icon == 1 {
                    Image(systemName: "flame.fill")
                        .foregroundColor(.red)
                        .font(.system(size: 10))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
            .background(Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(PlainButtonStyle())
        .onHover { isHovered in
            // Visual feedback handled by macOS
        }
    }
    
    // MARK: - 建议部分
    private func suggestionSection(title: String, items: [SuggestionItem]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.secondary)
                .padding(.horizontal, 12)
                .padding(.top, 8)
            
            ForEach(items, id: \.title) { item in
                item
            }
        }
    }
    
    // MARK: - 搜索建议部分
    private func suggestSection(section: SuggestSection, items: [SuggestItem]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            // 根据LableName显示不同的标题
            let sectionTitle = sectionTitle(for: section.LableName)
            Text(sectionTitle)
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.secondary)
                .padding(.horizontal, 12)
                .padding(.top, 8)
            
            ForEach(Array(items.prefix(3)), id: \.HintInfo) { item in
                if let hintInfo = item.HintInfo {
                    SuggestionItem(
                        title: hintInfo,
                        subtitle: item.HintInfo2 ?? "",
                        icon: sectionIcon(for: section.LableName),
                        action: {
                            handleSuggestSelection(hintInfo)
                        }
                    )
                }
            }
        }
    }
    
    private func sectionTitle(for label: String?) -> String {
        guard let label = label else { return "推荐" }
        switch label {
        case "MV": return "MV"
        case "专辑": return "专辑"
        default: return "歌曲"
        }
    }
    
    private func sectionIcon(for label: String?) -> String {
        guard let label = label else { return "music.note" }
        switch label {
        case "MV": return "video.fill"
        case "专辑": return "square.stack"
        default: return "music.note"
        }
    }
    
    // MARK: - 方法
    private func loadInitialData() {
        Task {
            await loadHotSearch()
            await loadDefaultKeyword()
        }
    }
    
    private func loadHotSearch() async {
        print("🌐 开始加载热搜数据...")
        await MainActor.run {
            isLoading = true
        }
        
        do {
            print("🌐 调用 searchService.getHotSearch()...")
            let result = try await searchService.getHotSearch()
            print("🌐 API 调用成功，处理响应数据...")
            await MainActor.run {
                if let list = result.data?.list, let firstList = list.first, let keywords = firstList.keywords {
                    hotSearchItems = keywords
                    print("🌐 热搜数据加载成功，数量: \(keywords.count)")
                    for (index, item) in keywords.prefix(3).enumerated() {
                        print("🌐 热搜项 \(index + 1): \(item.keyword ?? "无标题")")
                    }
                } else {
                    print("🌐 热搜数据结构异常: \(result)")
                }
                isLoading = false
            }
        } catch {
            print("🌐 API 调用失败: \(error)")
            await MainActor.run {
                print("🌐 加载热搜失败: \(error)")
                isLoading = false
            }
        }
    }
    
    private func loadDefaultKeyword() async {
        do {
            let result = try await searchService.getDefaultSearchKeyword()
            await MainActor.run {
                // 从fallback数据中获取默认搜索关键词
                if let fallback = result.data?.fallback, let firstFallback = fallback.first {
                    defaultKeyword = firstFallback.main_title ?? ""
                }
            }
        } catch {
            print("加载默认搜索关键词失败: \(error)")
        }
    }
    
    private func handleTextChange(_ text: String) {
        searchText = text
        
        // 取消之前的定时器
        searchDebounceTimer?.invalidate()
        
        // 设置新的定时器，300ms后执行搜索
        searchDebounceTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { _ in
            DispatchQueue.main.async {
                debouncedSearchText = searchText
            }
        }
    }
    
    private func loadSearchSuggestions(keyword: String) {
        Task {
            await MainActor.run {
                isLoading = true
            }
            
            do {
                let result = try await searchService.searchSuggest(keyword: keyword)
                await MainActor.run {
                    searchSuggestions = result
                    isLoading = false
                    print("搜索建议加载成功")
                }
            } catch {
                await MainActor.run {
                    errorMessage = "加载搜索建议失败"
                    isLoading = false
                    print("搜索建议加载失败: \(error)")
                }
            }
        }
    }
    
    private func performSearch() {
        guard !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        
        isTextFieldFocused = false
        showPopover = false
        isSearching = true
        isLoading = true
        
        // 显示搜索结果页面
        showingSearchResultsView = true
        
        Task {
            do {
                let result = try await searchService.search(keyword: searchText, type: .song)
                await MainActor.run {
                    searchResults = result
                    isLoading = false
                    showSearchResults = true
                }
            } catch {
                await MainActor.run {
                    errorMessage = "搜索失败"
                    isLoading = false
                }
            }
        }
    }
    
    private func clearSearch() {
        searchText = ""
        searchResults = nil
        searchSuggestions = nil
        isTextFieldFocused = false
        showPopover = false
        showSearchResults = false
        errorMessage = ""
    }
    
    private func handleSongSelection(_ song: Song) {
        playerService.playSong(song)
        clearSearch()
    }
    
    private func handleArtistSelection(_ artist: Artist) {
        searchText = artist.name ?? ""
        isTextFieldFocused = false
        showPopover = false
        // 这里可以跳转到歌手页面
    }
    
    private func handlePlaylistSelection(_ playlist: Playlist) {
        searchText = playlist.name ?? ""
        isTextFieldFocused = false
        showPopover = false
        // 这里可以跳转到歌单页面
    }
    
    private func handleHotSearchSelection(_ item: HotSearchItem) {
        if let keyword = item.keyword {
            searchText = keyword
            // 关闭弹出框
            showPopover = false
            // 直接显示搜索结果页面
            showingSearchResultsView = true
        }
    }
    
    private func handleSuggestSelection(_ keyword: String) {
        searchText = keyword
        // 关闭弹出框
        showPopover = false
        // 直接显示搜索结果页面
        showingSearchResultsView = true
    }
}

// MARK: - 建议项
struct SuggestionItem: View {
    let title: String
    let subtitle: String
    let icon: String
    let action: () -> Void
    
    @State private var isHovered = false
    
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .foregroundColor(.secondary)
                    .font(.system(size: 10))
                
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 11))
                        .foregroundColor(.primary)
                        .lineLimit(1)
                    
                    if !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.system(size: 9))
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                }
                
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
            .background(isHovered ? Color.gray.opacity(0.1) : Color.clear)
            .contentShape(Rectangle())
            .onHover { hovering in
                isHovered = hovering
            }
        }
        .buttonStyle(PlainButtonStyle())
    }
}
