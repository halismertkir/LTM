#if !canImport(Combine)
// Platforms without Combine (the Linux build that runs the unit tests) get inert
// stand-ins, so view-model classes compile unchanged. The apps always use real Combine.

public protocol ObservableObject: AnyObject {}

@propertyWrapper
public struct Published<Value> {
    public var wrappedValue: Value

    public init(wrappedValue: Value) {
        self.wrappedValue = wrappedValue
    }
}
#endif
