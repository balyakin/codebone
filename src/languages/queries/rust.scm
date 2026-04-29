(use_declaration) @import

(function_item
  name: (identifier) @function.name
) @function.def

(struct_item
  name: (type_identifier) @struct.name
) @struct.def

(enum_item
  name: (type_identifier) @enum.name
) @enum.def

(trait_item
  name: (type_identifier) @trait.name
) @trait.def

(impl_item
  type: (type_identifier) @impl.name
) @impl.def

(mod_item
  name: (identifier) @module.name
) @module.def

(call_expression
  function: [
    (identifier) @reference
    (field_expression field: (field_identifier) @reference)
  ])
