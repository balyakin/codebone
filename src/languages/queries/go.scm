(import_declaration) @import

(function_declaration
  name: (identifier) @function.name
) @function.def

(method_declaration
  name: (field_identifier) @method.name
) @method.def

(type_declaration
  (type_spec
    name: (type_identifier) @struct.name
    type: (struct_type)
  )
) @struct.def

(type_declaration
  (type_spec
    name: (type_identifier) @interface.name
    type: (interface_type)
  )
) @interface.def

(const_declaration) @constant.def
(var_declaration) @variable.def

(call_expression
  function: [
    (identifier) @reference
    (selector_expression field: (field_identifier) @reference)
  ])
