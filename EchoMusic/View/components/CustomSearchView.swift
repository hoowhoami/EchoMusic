//
//  CustomSearchView.swift
//  EchoMusic
//
//  Created by AI Assistant on 2025/8/20.
//

import SwiftUI
import AppKit

// 搜索文本视图组件：包含完整的搜索功能
struct CustomSearchView: View {
    @State private var searchText = ""
    @State private var isSearching = false
    @State private var showSearchResults = false
    @State private var searchSuggestions: SearchSuggestResult?
    @State private var hotSearchItems: [HotSearchItem] = []
    @State private var defaultKeyword: String = ""
    @State private var isLoading = false
    @State private var isHotSearchLoading = false
    @State private var errorMessage = ""
    
    @FocusState private var isTextFieldFocused: Bool
    @State private var showDropdown = false
    @State private var debouncedSearchText = ""
    @State private var showingSearchResultsView = false
    @State private var searchDebounceTimer: Timer?
    @State private var dropdownFrame: CGRect = .zero
    @State private var window: NSWindow?
    
    private let searchService = SearchService.shared
    private let playerService = PlayerService.shared
    
    var body: some View {
        HStack(spacing: 0) {
            Spacer()
            
            searchFieldView
              
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .frame(height: 40)
        .background(Color.clear)
        .sheet(isPresented: $showingSearchResultsView) {
            if !searchText.isEmpty {
                SearchResultsView(keyword: searchText)
                    .frame(width: 800, height: 600)
            }
        }
        .onAppear {
            setupSearch()
        }
    }
    
    // MARK: - Search Field View
    private var searchFieldView: some View {
        HStack(alignment: .center, spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundColor(.secondary)
                .font(.system(size: 13))
                .frame(width: 13, height: 13)
            
            ZStack(alignment: .leading) {
                if searchText.isEmpty {
                    Text(defaultKeyword.isEmpty ? "搜索音乐、歌手、歌单、分享码" : defaultKeyword)
                        .foregroundColor(.secondary)
                        .font(.system(size: 12))
                }
                
                TextField("", text: $searchText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
                    .focused($isTextFieldFocused)
                    .onSubmit {
                        performSearch()
                    }
                    .onChange(of: searchText) { newValue in
                        handleTextChange(newValue)
                    }
                    .onTapGesture {
                        // 点击文本框时确保弹出层显示并获取焦点
                        if !showDropdown {
                            showDropdown = true
                            // 确保热搜数据已加载
                            if hotSearchItems.isEmpty && !isHotSearchLoading {
                                loadHotSearch()
                            }
                        }
                        isTextFieldFocused = true
                    }
            }
            
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
        .onTapGesture {
            // 点击整个搜索框时显示下拉框并获取焦点
            if !showDropdown {
                showDropdown = true
                // 确保热搜数据已加载
                if hotSearchItems.isEmpty && !isHotSearchLoading {
                    loadHotSearch()
                }
            }
            isTextFieldFocused = true
        }
        .onAppear {
            window = NSApplication.shared.windows.first
        }
        .onChange(of: isTextFieldFocused) { focused in
            if focused {
                // 获得焦点时显示下拉框
                showDropdown = true
                // 确保热搜数据已加载
                if hotSearchItems.isEmpty && !isHotSearchLoading {
                    loadHotSearch()
                }
            }
        }
        .popover(isPresented: $showDropdown, arrowEdge: .bottom) {
            PopoverContainer {
                SearchPopoverContent(
                    searchText: searchText,
                    searchSuggestions: searchSuggestions,
                    hotSearchItems: hotSearchItems,
                    isLoading: isLoading,
                    isHotSearchLoading: isHotSearchLoading,
                    onItemSelected: { keyword in
                        searchText = keyword
                        showDropdown = false
                        showingSearchResultsView = true
                        isTextFieldFocused = false
                    }
                )
            }
            .frame(width: 320)
            .frame(height: 200) // 固定高度，避免太高
        }
    }
    
    // MARK: - Setup Methods
    private func setupSearch() {
        loadHotSearch()
        loadDefaultKeyword()
        window = NSApplication.shared.windows.first
    }
    
    private func loadHotSearch() {
        Task<Void, Never> {
            isHotSearchLoading = true
            do {
                let result = try await searchService.getHotSearch()
                // 正确解析热搜数据：遍历所有热搜列表，收集所有关键词
                var allKeywords: [HotSearchItem] = []
                if let lists = result.data?.list {
                    print("热搜列表数量: \(lists.count)")
                    for list in lists {
                        print("列表名称: \(list.name ?? "无")")
                        if let keywords = list.keywords {
                            print("关键词数量: \(keywords.count)")
                            allKeywords.append(contentsOf: keywords)
                        }
                    }
                }
                print("总共获取到 \(allKeywords.count) 个热搜项")
                self.hotSearchItems = allKeywords
                self.isHotSearchLoading = false
            } catch {
                print("加载热搜失败: \(error)")
                self.hotSearchItems = []
                self.isHotSearchLoading = false
            }
        }
    }
    
    private func loadDefaultKeyword() {
        Task<Void, Never> {
            do {
                let result = try await searchService.getDefaultSearchKeyword()
                // 从广告数据中获取默认搜索关键字
                if let ads = result.data?.ads, let firstAd = ads.first {
                    self.defaultKeyword = firstAd.title ?? ""
                }
            } catch {
                print("加载默认搜索关键字失败: \(error)")
                self.defaultKeyword = ""
            }
        }
    }
    
    // MARK: - Search Methods
    private func performSearch() {
        guard !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        
        isSearching = true
        showSearchResults = true
        showDropdown = false
        
        Task<Void, Never> {
            do {
                // 使用默认的歌曲搜索
                let result = try await searchService.searchSong(keyword: searchText)
                self.isSearching = false
                self.showingSearchResultsView = true
            } catch {
                    self.errorMessage = "搜索失败: \(error.localizedDescription)"
                    self.isSearching = false
            }
        }
    }
    
    private func clearSearch() {
        searchText = ""
        // searchResults = nil
        searchSuggestions = nil
        showSearchResults = false
        // 清空搜索文本时，如果有热搜内容则显示下拉框
        showDropdown = !hotSearchItems.isEmpty
    }
    
    private func handleTextChange(_ newValue: String) {
        // 取消之前的防抖计时器
        searchDebounceTimer?.invalidate()
        
        // 更新防抖文本
        debouncedSearchText = newValue
        
        // 处理下拉框显示逻辑
        if !showDropdown && !newValue.isEmpty {
            // 如果下拉框未显示且输入了内容，自动显示下拉框
            showDropdown = true
        }
        
        if showDropdown {
            if newValue.isEmpty {
                // 文本为空时显示热搜
                searchSuggestions = nil
            } else {
                // 文本不为空时加载搜索建议
                searchDebounceTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { _ in
                    Task<Void, Never> {
                        await self.loadSearchSuggestions()
                    }
                }
            }
        }
    }
    
    private func loadSearchSuggestions() async {
        guard !debouncedSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            searchSuggestions = nil
            return
        }
        
        isLoading = true
        
        do {
            let result = try await searchService.searchSuggest(keyword: debouncedSearchText)
            self.searchSuggestions = result
            self.isLoading = false
        } catch {
            print("加载搜索建议失败: \(error)")
            self.searchSuggestions = nil
            self.isLoading = false
        }
    }
    
    // MARK: - Handler Methods
    private func handleHotSearchSelection(_ item: HotSearchItem) {
        if let keyword = item.keyword {
            self.searchText = keyword
            // 关闭下拉框
            self.showDropdown = false
            // 直接显示搜索结果页面
            self.showingSearchResultsView = true
        }
    }
    
    private func handleSuggestSelection(_ keyword: String) {
        self.searchText = keyword
        // 关闭下拉框
        self.showDropdown = false
        // 直接显示搜索结果页面
        self.showingSearchResultsView = true
    }
}

// MARK: - Search Popover Content
struct SearchPopoverContent: View {
    let searchText: String
    let searchSuggestions: SearchSuggestResult?
    let hotSearchItems: [HotSearchItem]
    let isLoading: Bool
    let isHotSearchLoading: Bool
    let onItemSelected: (String) -> Void
    
    var body: some View {
        ScrollView {
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
                    if hotSearchItems.isEmpty && !isHotSearchLoading {
                        // 如果热搜为空且不在加载中，显示空状态
                        emptyHotSearchView
                    } else if hotSearchItems.isEmpty && isHotSearchLoading {
                        // 正在加载热搜
                        loadingView
                    } else {
                        // 显示热搜内容
                        hotSearchContent
                    }
                }
            }
            .padding(.vertical, 8)
        }
        .frame(maxWidth: .infinity)
    }
    
    // MARK: - Loading View
    private var loadingView: some View {
        HStack {
            Spacer()
            ProgressView()
                .scaleEffect(0.8)
            Spacer()
        }
        .padding()
    }
    
    // MARK: - Empty Views
    private var emptySuggestionsView: some View {
        VStack {
            Spacer()
            HStack {
                Spacer()
                VStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .foregroundColor(.secondary)
                        .font(.system(size: 20))
                    Text("暂无搜索建议")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                    Text("请尝试其他关键词")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary.opacity(0.8))
                }
                Spacer()
            }
            Spacer()
        }
        .frame(height: 120)
    }
    
    private var emptyHotSearchView: some View {
        VStack {
            Spacer()
            HStack {
                Spacer()
                VStack(spacing: 8) {
                    Image(systemName: "flame")
                        .foregroundColor(.secondary)
                        .font(.system(size: 20))
                    Text("暂无热搜内容")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                    Text("请稍后再试")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary.opacity(0.8))
                }
                Spacer()
            }
            Spacer()
        }
        .frame(height: 120)
    }
    
    // MARK: - Search Suggestions Content
    private var searchSuggestionsContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let sections = searchSuggestions?.data {
                ForEach(sections, id: \.LableName) { section in
                    if let items = section.RecordDatas, !items.isEmpty {
                        suggestSection(section: section, items: items)
                    }
                }
            }
        }
    }
    
    // MARK: - Hot Search Content
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
        .onAppear {
            print("显示热搜内容，共有 \(hotSearchItems.count) 项")
        }
    }
    
    // MARK: - Hot Search Item View
    private func hotSearchItemView(index: Int, item: HotSearchItem) -> some View {
        Button(action: {
            if let keyword = item.keyword {
                onItemSelected(keyword)
            }
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
    }
    
    // MARK: - Suggest Section
    private func suggestSection(section: SuggestSection, items: [SuggestItem]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            let sectionTitle = sectionTitle(for: section.LableName)
            Text(sectionTitle)
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(.secondary)
                .padding(.horizontal, 12)
                .padding(.top, 8)
            
            ForEach(Array(items.prefix(3)), id: \.HintInfo) { item in
                if let hintInfo = item.HintInfo {
                    suggestionItemView(
                        title: hintInfo,
                        subtitle: item.HintInfo2 ?? "",
                        icon: sectionIcon(for: section.LableName),
                        action: {
                            onItemSelected(hintInfo)
                        }
                    )
                }
            }
        }
    }
    
    // MARK: - Suggestion Item View
    private func suggestionItemView(title: String, subtitle: String, icon: String, action: @escaping () -> Void) -> some View {
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
            .background(Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(PlainButtonStyle())
    }
    
    // MARK: - Helper Methods
    private func sectionTitle(for label: String?) -> String {
        guard let label = label else { return "推荐" }
        switch label {
        case "专辑": return "专辑"
        case "歌手": return "歌手"
        case "歌单": return "歌单"
        default: return "歌曲"
        }
    }
    
    private func sectionIcon(for label: String?) -> String {
        guard let label = label else { return "music.note" }
        switch label {
        case "专辑": return "square.stack"
        case "歌手": return "person.fill"
        case "歌单": return "list.bullet"
        default: return "music.note"
        }
    }
}

// MARK: - Popover Container
struct PopoverContainer<Content: View>: View {
    let content: Content
    
    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }
    
    var body: some View {
        content
            .background(Color(.windowBackgroundColor))
            .cornerRadius(8)
            .shadow(color: .black.opacity(0.2), radius: 8, x: 0, y: 4)
    }
}

// MARK: - Dropdown Frame Preference Key
struct DropdownFramePreferenceKey: PreferenceKey {
    static var defaultValue: CGRect = .zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        value = nextValue()
    }
}

